require('dotenv').config();

const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs');
const https = require('https');
const fuzzy = require('fuzzy');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEBETA_API_KEY = process.env.GEBETA_API_KEY;
const GEBETA_BASE_URL = process.env.GEBETA_BASE_URL;

const path = require('path');

// Path to log file
const logFile = path.join(__dirname, 'conlog.txt');

// Wrap the original console.log
const originalLog = console.log;

console.log = function (...args) {
  const time = new Date().toISOString();
  const message = args.map(a => 
    (typeof a === 'object' ? JSON.stringify(a, null, 2) : a)
  ).join(' ');

  const logLine = `[${time}] ${message}\n`;

  // Append log to file
  fs.appendFileSync(logFile, logLine, 'utf8');

  // Still show logs in console
  originalLog.apply(console, args);
};

console.log("logging started");

const bot = new Bot(BOT_TOKEN);

// Load ATMs from CSV
function loadATMs() {
  const data = fs.readFileSync('atms.csv', 'utf8');
  const lines = data.trim().split('\n');
  const atms = [];
  
  for (let i = 1; i < lines.length; i++) {
    const [id, name, lat, lon] = lines[i].split(',');
    if (id && name && lat && lon) {
      atms.push({
        id: id.trim(),
        name: name.trim(),
        lat: parseFloat(lat.trim()),
        lon: parseFloat(lon.trim())
      });
    }
  }
  
  console.log(`Loaded ${atms.length} ATMs from CSV`);
  return atms;
}

const atms = loadATMs();

// Session setup
bot.use(session({
  initial: () => ({ waitingFor: null })
}));

// Extract name after dash
function extractNameAfterDash(fullName) {
  const parts = fullName.split('-');
  const extracted = parts.length > 1 ? parts[1].trim() : fullName.trim();
  console.log(`Extracted "${extracted}" from "${fullName}"`);
  return extracted;
}

// Normalize text for fuzzy matching (for preprocessing before fuzzy.filter)
function normalizeText(text) {
  let normalized = text
    .toLowerCase()
    .replace(/iya/gi, 'ia')
    .replace(/[aeiou]/gi, '')
    .replace(/t/gi, 'x')
    .replace(/k/gi, 'q')
    .replace(/\s+/g, '');
  
  console.log(`Normalized "${text}" to "${normalized}"`);
  return normalized;
}

// Finding ATM matches by name using fuzzy npm package
function findATMsByName(searchName) {
  console.log(`\n=== Searching for ATMs matching: "${searchName}" ===`);
  
  // Prepare ATM names for fuzzy search
  const atmNames = atms.map(atm => ({
    original: atm,
    searchString: extractNameAfterDash(atm.name)
  }));
  
  // Use fuzzy matching with pre-processing
  const options = {
    pre: '<',
    post: '>',
    extract: (el) => normalizeText(el.searchString)
  };
  
  const normalizedSearch = normalizeText(searchName);
  const results = fuzzy.filter(normalizedSearch, atmNames, options);
  
  // Map results back to ATM objects with scores
  const matches = results.map(result => ({
    ...result.original.original,
    score: result.score
  }));
  
  console.log(`Found ${matches.length} matching ATMs using fuzzy search`);
  matches.slice(0, 5).forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} (score: ${atm.score})`);
  });
  
  return matches;
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Make API request to Gebeta Maps using One-to-Many
function gebetaOneToMany(originLat, originLon, destinations) {
  return new Promise((resolve, reject) => {
    // Build the destinations parameter - curly braces with comma separation
    const destCoords = destinations.map(d => `{${d.lat},${d.lon}}`).join(',');
    const jsonParam = `[${destCoords}]`;
    
    const url = `${GEBETA_BASE_URL}/api/route/onm?origin={${originLat},${originLon}}&json=${jsonParam}&apiKey=${GEBETA_API_KEY}`;

    console.log(`Calling Gebeta API: ${url}`);
    
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Gebeta API Response Status: ${res.statusCode}`);
        if (res.statusCode !== 200) {
          console.log(`Gebeta API Error Response: ${data}`);
          reject(new Error(`API returned status ${res.statusCode}`));
          return;
        }
        
        try {
          const parsed = JSON.parse(data);
          console.log(`Gebeta API Success:`, JSON.stringify(parsed).substring(0, 2000));
          resolve(parsed);
        } catch (e) {
          console.error('Failed to parse Gebeta response:', e);
          reject(e);
        }
      });
    }).on('error', (err) => {
      console.error('Gebeta API request failed:', err);
      reject(err);
    });
  });
}

// Get nearest ATMs - first 10 by Haversine, then best 5 via Gebeta API
async function getNearestATMs(userLat, userLon) {
  console.log(`\n=== Finding nearest ATMs to location: ${userLat}, ${userLon} ===`);
  
  // Step 1: Calculate Haversine distance for all ATMs
  console.log('Step 1: Calculating Haversine distances for all ATMs');
  const withDistances = atms.map(atm => {
    const distance = calculateDistance(userLat, userLon, atm.lat, atm.lon);
    return {
      ...atm,
      distance: distance
    };
  });
  
  // Step 2: Get 10 closest ATMs by Haversine
  const closest10 = withDistances
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);
  
  console.log('Step 2: Top 10 closest ATMs by Haversine:');
  closest10.forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} - ${atm.distance.toFixed(2)} km`);
  });
  
  try {
    // Step 3: Use Gebeta API to find best 5 from the 10 closest
    console.log('Step 3: Using Gebeta API to find best 5 routes');
    const response = await gebetaOneToMany(userLat, userLon, closest10);
    
    if (response && response.origin_to_destination && Array.isArray(response.origin_to_destination)) {
      console.log(`Gebeta returned ${response.origin_to_destination.length} routes`);
      
      // Map API distances to ATMs
      // Note: origin_to_destination[0] is origin to origin (distance 0)
      // origin_to_destination[1] corresponds to closest10[0], etc.
      const withApiDistances = closest10.map((atm, idx) => {
        // idx + 1 because origin_to_destination includes origin-to-origin at index 0
        const routeData = response.origin_to_destination[idx + 1];
        const distance = routeData && routeData.distance !== undefined ? routeData.distance : atm.distance;
        const duration = routeData && routeData.time !== undefined ? routeData.time : null;
        return {
          ...atm,
          apiDistance: distance,
          duration: duration,
          haversineDistance: atm.distance
        };
      });
      
      // Sort by API distance and get top 5
      const best5 = withApiDistances
        .sort((a, b) => a.apiDistance - b.apiDistance)
        .slice(0, 5);
      
      console.log('Step 4: Best 5 ATMs by Gebeta API distance:');
      best5.forEach((atm, idx) => {
        console.log(`${idx + 1}. ${atm.name} - ${atm.apiDistance.toFixed(2)} km (API), ${atm.haversineDistance.toFixed(2)} km (Haversine)`);
      });
      
      return best5.map(atm => ({
        ...atm,
        distance: atm.apiDistance // Use API distance for display
      }));
    }
  } catch (error) {
    console.error('Gebeta API error, returning top 5 from Haversine:', error.message);
  }
  
  // Fallback: return top 5 from Haversine if API fails
  console.log('Fallback: Returning top 5 from Haversine calculation');
  return closest10.slice(0, 5);
}

// Get ATMs sorted by proximity to a reference ATM
async function getATMsSortedByProximity(referenceATMs) {
  if (referenceATMs.length === 0) {
    console.log('No reference ATMs provided');
    return [];
  }
  
  // Use the best matching ATM as reference
  const refATM = referenceATMs[0];
  console.log(`\n=== Sorting ATMs by proximity to: ${refATM.name} ===`);
  
  // Step 1: Calculate Haversine distances from reference ATM
  console.log('Step 1: Calculating Haversine distances from reference ATM');
  const withDistances = atms.map(atm => {
    const distance = calculateDistance(refATM.lat, refATM.lon, atm.lat, atm.lon);
    return {
      ...atm,
      distance: distance
    };
  });
  
  // Step 2: Get 10 closest ATMs
  const closest10 = withDistances
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);
  
  console.log('Step 2: Top 10 closest ATMs by Haversine:');
  closest10.forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} - ${atm.distance.toFixed(2)} km`);
  });
  
  try {
    // Step 3: Use Gebeta API to find best 5
    console.log('Step 3: Using Gebeta API to find best 5 routes');
    const response = await gebetaOneToMany(refATM.lat, refATM.lon, closest10);
    
    if (response && response.origin_to_destination && Array.isArray(response.origin_to_destination)) {
      // Map API distances to ATMs
      // origin_to_destination[0] is origin to origin, [1] corresponds to closest10[0], etc.
      const withApiDistances = closest10.map((atm, idx) => {
        const routeData = response.origin_to_destination[idx + 1];
        const distance = routeData && routeData.distance !== undefined ? routeData.distance : atm.distance;
        const duration = routeData && routeData.time !== undefined ? routeData.time : null;
        return {
          ...atm,
          apiDistance: distance,
          duration: duration,
          haversineDistance: atm.distance
        };
      });
      
      const best5 = withApiDistances
        .sort((a, b) => a.apiDistance - b.apiDistance)
        .slice(0, 5);
      
      console.log('Step 4: Best 5 ATMs by Gebeta API:');
      best5.forEach((atm, idx) => {
        console.log(`${idx + 1}. ${atm.name} - ${atm.apiDistance.toFixed(2)} km`);
      });
      
      return best5.map(atm => ({
        ...atm,
        distance: atm.apiDistance
      }));
    }
  } catch (error) {
    console.error('Gebeta API error, using Haversine fallback:', error.message);
  }
  
  // Fallback
  return closest10.slice(0, 5);
}

// Command handlers
bot.command('start', async (ctx) => {
  const welcomeMessage = `
🏧 Welcome to Hawassa ATM Locator Bot!

I can help you find the nearest ATMs.

Please choose how you'd like to search:
• Share your 📍 location to find nearby ATMs
• Type an the name of your hood to search by name

Example: "Piasa" "Atote" "Arab Sefer"
  `;
  
  await ctx.reply(welcomeMessage.trim());
  ctx.session.waitingFor = 'input';
});

bot.command('help', async (ctx) => {
  const helpMessage = `
🏧 ATM Locator Bot Help

How to use:
1. Send your location - I'll find the 5 nearest ATMs
2. Type your hood (ሰፈር) - I'll search for matching ATMs

Commands:
/start - Start the bot
/help - Show this help message

Examples:
• Send location via Telegram's location feature
• Type: "Piasa"
• Type: "Atote"
  `;
  
  await ctx.reply(helpMessage.trim());
});

// Handle location messages
bot.on('message:location', async (ctx) => {
  await ctx.reply('🔍 Finding nearest ATMs...');

  const { latitude, longitude } = ctx.message.location;
  console.log(`\n========================================`);
  console.log(`Received location: ${latitude}, ${longitude}`);
  console.log(`========================================`);

  try {
    const nearestATMs = await getNearestATMs(latitude, longitude);

    if (nearestATMs.length === 0) {
      await ctx.reply('❌ No ATMs found nearby.');
      return;
    }

    const count = nearestATMs.length;
    await ctx.reply(`📍 Found ${count} nearest ATM${count > 1 ? 's' : ''}:`);

    // Send each ATM in a separate message with location
    for (const [index, atm] of nearestATMs.entries()) {
      const message = `#${index + 1}. ${atm.name}\n📏 ${atm.distance.toFixed(2)} km away\n📍 ${atm.lat}, ${atm.lon}`;
      // const message2 = `#${index + 1}. ${atm.name}\n📏 ${atm.distance.toFixed(2)} km away\n📍 ${atm.lat}, ${atm.lon}`;
    
      await ctx.reply(message);

      await ctx.replyWithLocation(atm.lat, atm.lon, {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗺️ View on Map', url: `https://www.google.com/maps?q=${atm.lat},${atm.lon}` }
          ]]
        }
      });

      await new Promise(r => setTimeout(r, 500));
    }

  } catch (error) {
    console.error('Error processing location:', error);
    await ctx.reply('❌ An error occurred while searching for ATMs. Please try again.');
  }
});

// Handle text messages
bot.on('message:text', async (ctx) => {
  const searchText = ctx.message.text.trim();

  if (searchText.startsWith('/')) return;

  console.log(`\n========================================`);
  console.log(`Received text search: "${searchText}"`);
  console.log(`========================================`);

  await ctx.reply('🔍 Searching for ATMs...');

  try {
    const matchingATMs = findATMsByName(searchText);

    if (matchingATMs.length === 0) {
      await ctx.reply(`❌ No ATMs found matching "${searchText}". Please try a different name.`);
      return;
    }

    const sortedATMs = await getATMsSortedByProximity(matchingATMs);

    if (sortedATMs.length === 0) {
      await ctx.reply(`❌ No ATMs found. Please try again.`);
      return;
    }

    const matchCount = sortedATMs.length;
    await ctx.reply(`🏧 Found ${matchCount} matching ATM${matchCount > 1 ? 's' : ''}.`);

    for (const [index, atm] of sortedATMs.entries()) {
      const message = `#${index + 1}. ${atm.name}\n📍 ${atm.lat}, ${atm.lon}\n `;

      await ctx.reply(message);
      
      await ctx.replyWithLocation(atm.lat, atm.lon, {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗺️ View on Map', url: `https://www.google.com/maps?q=${atm.lat},${atm.lon}` }
          ]]
        }
      });

      await new Promise(r => setTimeout(r, 500));
    }

  } catch (error) {
    console.error('Error processing text search:', error);
    await ctx.reply('❌ An error occurred while searching for ATMs. Please try again.');
  }
});

// Error handling
bot.catch((err) => {
  console.error('Bot error:', err);
});

// Start the bot
bot.start({
  onStart: (botInfo) => {
    console.log(`========================================`);
    console.log(`Bot @${botInfo.username} started successfully!`);
    console.log(`Loaded ${atms.length} ATMs`);
    console.log(`========================================\n`);
  }
});

console.log('ATM Locator Bot is running...');