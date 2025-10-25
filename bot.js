require('dotenv').config();

const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs');
const https = require('https');


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

// Example usage
console.log("logging started");

// Example: initialize your bot
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

// Normalize text for fuzzy matching
function normalizeText(text) {
  let normalized = text
    .toLowerCase()
    .replace(/iya/gi, 'ia') // iya and ia are the same (do this first)
    .replace(/[aeiou]/gi, '') // Remove vowels
    .replace(/t/gi, 'x') // T and X are same - normalize to x
    .replace(/k/gi, 'q') // K and Q are same - normalize to q
    .replace(/\s+/g, ''); // Remove spaces
  
  console.log(`Normalized "${text}" to "${normalized}"`);
  return normalized;
}

// Extract name after dash
function extractNameAfterDash(fullName) {
  const parts = fullName.split('-');
  const extracted = parts.length > 1 ? parts[1].trim() : fullName.trim();
  console.log(`Extracted "${extracted}" from "${fullName}"`);
  return extracted;
}

// Calculate similarity score
function getSimilarityScore(str1, str2) {
  const norm1 = normalizeText(str1);
  const norm2 = normalizeText(str2);
  
  // Exact match
  if (norm1 === norm2) return 1.0;
  
  // Check if one contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    return 0.8;
  }
  
  // Levenshtein distance for fuzzy matching
  const m = norm1.length;
  const n = norm2.length;
  
  if (m === 0) return n === 0 ? 1 : 0;
  if (n === 0) return 0;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (norm1[i - 1] === norm2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1
        );
      }
    }
  }
  
  const maxLen = Math.max(m, n);
  const similarity = 1 - (dp[m][n] / maxLen);
  console.log(`Similarity between "${str1}" and "${str2}": ${similarity.toFixed(2)}`);
  return similarity;
}

// finding atm matches by name
function findATMsByName(searchName) {
  console.log(`\n=== Searching for ATMs matching: "${searchName}" ===`);
  
  const matches = atms.map(atm => {
    const atmName = extractNameAfterDash(atm.name);
    const score = getSimilarityScore(searchName, atmName);
    return { ...atm, score };
  });
  
  const filtered = matches.filter(m => m.score > 0.3); // Lower threshold for better results
  const sorted = filtered.sort((a, b) => b.score - a.score);
  
  console.log(`Found ${sorted.length} matching ATMs`);
  sorted.slice(0, 5).forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} (score: ${atm.score.toFixed(2)})`);
  });
  
  return sorted;
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
function gebetaOneToMany(originLon, originLat, destinations) {
  return new Promise((resolve, reject) => {
    // Build the destinations parameter
    const destCoords = destinations.map(d => `${d.lon},${d.lat}`).join(';');
    const url = `${GEBETA_BASE_URL}/api/v1/route/onm?origin=${originLon},${originLat}&destinations=${destCoords}`;
    
    console.log(`Calling Gebeta API: ${url}`);
    
    https.get(url, {
      headers: {
        'Authorization': `Bearer ${GEBETA_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
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
          console.log(`Gebeta API Success:`, JSON.stringify(parsed).substring(0, 200));
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

// Get nearest ATMs using Gebeta One-to-Many API or fallback
async function getNearestATMs(userLat, userLon, limit = 5) {
  console.log(`\n=== Finding nearest ATMs to location: ${userLat}, ${userLon} ===`);
  
  try {
    // Try using Gebeta Maps One-to-Many API
    const response = await gebetaOneToMany(userLon, userLat, atms);
    
    if (response && response.routes && Array.isArray(response.routes)) {
      console.log(`Gebeta returned ${response.routes.length} routes`);
      
      // Map distances from API response
      const withDistances = atms.map((atm, idx) => {
        const route = response.routes[idx];
        const distance = route && route.distance ? route.distance / 1000 : 9999; // Convert m to km
        return {
          ...atm,
          distance: distance,
          duration: route && route.duration ? route.duration : null
        };
      });
      
      const sorted = withDistances.sort((a, b) => a.distance - b.distance).slice(0, limit);
      console.log('Sorted ATMs by API distance:');
      sorted.forEach((atm, idx) => {
        console.log(`${idx + 1}. ${atm.name} - ${atm.distance.toFixed(2)} km`);
      });
      
      return sorted;
    }
  } catch (error) {
    console.error('Gebeta API error, using fallback:', error.message);
  }
  
  // Fallback to Haversine distance calculation
  console.log('Using Haversine distance calculation (fallback)');
  const withDistances = atms.map(atm => {
    const distance = calculateDistance(userLat, userLon, atm.lat, atm.lon);
    return {
      ...atm,
      distance: distance
    };
  });
  
  const sorted = withDistances.sort((a, b) => a.distance - b.distance).slice(0, limit);
  console.log('Sorted ATMs by Haversine distance:');
  sorted.forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} - ${atm.distance.toFixed(2)} km`);
  });
  
  return sorted;
}

// Get ATMs sorted by proximity to a reference ATM
async function getATMsSortedByProximity(referenceATMs, limit = 5) {
  if (referenceATMs.length === 0) {
    console.log('No reference ATMs provided');
    return [];
  }
  
  // Use the best matching ATM as reference
  const refATM = referenceATMs[0];
  console.log(`\n=== Sorting ATMs by proximity to: ${refATM.name} ===`);
  
  // Calculate distances from reference ATM to all ATMs
  const withDistances = atms.map(atm => {
    const distance = calculateDistance(refATM.lat, refATM.lon, atm.lat, atm.lon);
    return {
      ...atm,
      distance: distance
    };
  });
  
  const sorted = withDistances.sort((a, b) => a.distance - b.distance).slice(0, limit);
  console.log('Sorted ATMs:');
  sorted.forEach((atm, idx) => {
    console.log(`${idx + 1}. ${atm.name} - ${atm.distance.toFixed(2)} km from ${refATM.name}`);
  });
  
  return sorted;
}

// Format ATM list for display
function formatATMList(atmList, showDistance = true) {
  return atmList.map((atm, idx) => {
    const distanceStr = showDistance && atm.distance !== undefined 
      ? ` - ${atm.distance.toFixed(2)} km away` 
      : '';
    return `${idx + 1}. ${atm.name}${distanceStr}\n   📍 ${atm.lat}, ${atm.lon}`;
  }).join('\n\n');
}

// Command handlers
bot.command('start', async (ctx) => {
  const welcomeMessage = `
🏧 Welcome to ATM Locator Bot!

I can help you find the nearest ATMs.

Please choose how you'd like to search:
• Share your 📍 location to find nearby ATMs
• Type an ATM name to search by name

Example: "Piasa" or "atote"
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
    const nearestATMs = await getNearestATMs(latitude, longitude, 5);

    if (nearestATMs.length === 0) {
      await ctx.reply('❌ No ATMs found nearby.');
      return;
    }

    const count = nearestATMs.length;
    await ctx.reply(`📍 Found ${count} nearest ATM${count > 1 ? 's' : ''}:`);

    // Send each ATM in a separate message with location
    for (const [index, atm] of nearestATMs.entries()) {
      const message = `#${index + 1}. ${atm.name}\n📏 ${atm.distance.toFixed(2)} km away\n📍 ${atm.lat}, ${atm.lon}`;

      await ctx.reply(message);

      await ctx.replyWithLocation(atm.lat, atm.lon, {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗺️ View on Map', url: `https://www.google.com/maps?q=${atm.lat},${atm.lon}` }
          ]]
        }
      });

      // Optional: avoid hitting rate limits
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

  // Skip if it's a command
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

    // Sort by proximity (limit 5)
    const sortedATMs = await getATMsSortedByProximity(matchingATMs, 5);

    if (sortedATMs.length === 0) {
      await ctx.reply(`❌ No ATMs found. Please try again.`);
      return;
    }

    const matchCount = sortedATMs.length;
    await ctx.reply(`🏧 Found ${matchCount} matching ATM${matchCount > 1 ? 's' : ''}.`);

    // Send each ATM as a separate message
    for (const [index, atm] of sortedATMs.entries()) {
      const message = `#${index + 1}. ${atm.name}\n📍 ${atm.lat}, ${atm.lon}\n📏 ${atm.distance.toFixed(2)} km away`;

      await ctx.reply(message);
      
      // Send location message
      await ctx.replyWithLocation(atm.lat, atm.lon, {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗺️ View on Map', url: `https://www.google.com/maps?q=${atm.lat},${atm.lon}` }
          ]]
        }
      });

      // Optional: small delay to prevent flood limit
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