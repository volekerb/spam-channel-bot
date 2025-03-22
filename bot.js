const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const imageHash = require('image-hash');

// Use environment variables for sensitive information (Railway automatically provides these)
const token = process.env.TELEGRAM_BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI || process.env.DATABASE_URL; // Railway provides DATABASE_URL for MongoDB
const groupId = process.env.TELEGRAM_GROUP_ID;

// Validate required environment variables
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

if (!mongoUri) {
  console.error('MONGODB_URI or DATABASE_URL environment variable is not set');
  process.exit(1);
}

if (!groupId) {
  console.warn('TELEGRAM_GROUP_ID environment variable is not set. The bot will work in any group it is added to.');
}

// Create a bot instance
const bot = new TelegramBot(token, { polling: true });

// MongoDB client
const client = new MongoClient(mongoUri);
const dbName = 'duplicate_detector';

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Function to hash media files using perceptual hashing
const hashMedia = (media, mediaType) => {
  return new Promise((resolve, reject) => {
    // Use traditional crypto hash as fallback
    const cryptoHash = () => {
      const hash = crypto.createHash('sha256');
      hash.update(media);
      return hash.digest('hex');
    };
    
    // For images, use perceptual hashing
    if (mediaType === 'photo' || mediaType === 'document') {
      try {
        // Use image-hash for perceptual hashing
        imageHash.imageHash(media, 16, true, (error, hash) => {
          if (error) {
            console.error('Error generating perceptual hash:', error);
            resolve(cryptoHash()); // Fallback to crypto hash
          } else {
            resolve(hash);
          }
        });
      } catch (error) {
        console.error('Error in perceptual hashing:', error);
        resolve(cryptoHash()); // Fallback to crypto hash
      }
    } else {
      // For videos and other media types, use crypto hash for now
      resolve(cryptoHash());
    }
  });
};

// Helper function to escape Markdown characters
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString()
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!')
    .replace(/-/g, '\\-');
}

// Format username as a mention if possible
function formatUserMention(user) {
  if (user.username && !user.username.includes(' ')) {
    return `@${user.username}`;
  } else {
    return user.username || user.userId;
  }
}

// Calculate Hamming distance between two perceptual hashes
function calculateHashDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) {
    return Infinity; // Return a large number if hashes can't be compared
  }
  
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }
  return distance;
}

// Find similar media using perceptual hash
async function findSimilarMedia(hash, mediaType, similarityThreshold = 5) {
  const db = client.db(dbName);
  
  // For traditional crypto hashes, we need an exact match
  if (mediaType !== 'photo' && mediaType !== 'document') {
    return await db.collection('media').findOne({ hash });
  }
  
  // For perceptual hashes, we allow some difference
  const allMedia = await db.collection('media')
    .find({ mediaType: { $in: ['photo', 'document'] } })
    .toArray();
  
  // Find the most similar media within threshold
  let mostSimilar = null;
  let lowestDistance = similarityThreshold + 1;
  
  for (const media of allMedia) {
    const distance = calculateHashDistance(hash, media.hash);
    if (distance <= similarityThreshold && distance < lowestDistance) {
      mostSimilar = media;
      lowestDistance = distance;
    }
  }
  
  return mostSimilar;
}

// Connect to MongoDB
async function connectToDatabase() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    // Create collections if they don't exist
    const db = client.db(dbName);
    await db.createCollection('media');
    await db.createCollection('userStats');
    await db.createCollection('duplicateTracking');
    
    console.log('Database collections initialized');
  } catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
  }
}

// Update user statistics
async function updateUserStatistics(userId, username, mediaType) {
  const db = client.db(dbName);
  const userStats = await db.collection('userStats').findOne({ userId });

  if (userStats) {
    // Update existing user statistics
    await db.collection('userStats').updateOne(
      { userId },
      { 
        $inc: { 
          [`${mediaType}Count`]: 1,
          totalMessages: 1 
        },
        $set: { 
          username,
          lastActive: new Date() 
        }
      }
    );
  } else {
    // Create new user statistics
    await db.collection('userStats').insertOne({
      userId,
      username,
      photoCount: mediaType === 'photo' ? 1 : 0,
      videoCount: mediaType === 'video' ? 1 : 0,
      documentCount: mediaType === 'document' ? 1 : 0,
      textCount: mediaType === 'text' ? 1 : 0,
      duplicatesPosted: 0,
      totalMessages: 1,
      firstSeen: new Date(),
      lastActive: new Date()
    });
  }
}

// Track duplicate posting
async function trackDuplicate(userId, username) {
  const db = client.db(dbName);
  
  // Update user's duplicate count
  await db.collection('userStats').updateOne(
    { userId },
    { 
      $inc: { duplicatesPosted: 1 },
      $set: { username, lastActive: new Date() }
    },
    { upsert: true }
  );
  
  // Add entry to duplicate tracking
  await db.collection('duplicateTracking').insertOne({
    userId,
    username,
    timestamp: new Date()
  });
}

// Generate weekly statistics
async function generateWeeklyStats() {
  const db = client.db(dbName);
  const stats = await db.collection('userStats').find().toArray();
  
  let statsMessage = '📊 *Weekly Channel Statistics* 📊\n\n';
  
  // Sort users by total messages
  stats.sort((a, b) => b.totalMessages - a.totalMessages);
  
  // Top contributors
  statsMessage += '*Top Contributors:*\n';
  for (let i = 0; i < Math.min(5, stats.length); i++) {
    const user = stats[i];
    statsMessage += `${i+1}. ${user.username || user.userId}: ${user.totalMessages} messages\n`;
  }
  
  // Media breakdown
  const totalPhotos = stats.reduce((sum, user) => sum + (user.photoCount || 0), 0);
  const totalVideos = stats.reduce((sum, user) => sum + (user.videoCount || 0), 0);
  const totalDocs = stats.reduce((sum, user) => sum + (user.documentCount || 0), 0);
  const totalTexts = stats.reduce((sum, user) => sum + (user.textCount || 0), 0);
  
  statsMessage += '\n*Media Breakdown:*\n';
  statsMessage += `📷 Photos: ${totalPhotos}\n`;
  statsMessage += `🎬 Videos: ${totalVideos}\n`;
  statsMessage += `📁 Documents: ${totalDocs}\n`;
  statsMessage += `💬 Text Messages: ${totalTexts}\n`;
  
  // Duplicate offenders
  statsMessage += '\n*Duplicate Offenders:*\n';
  const duplicateOffenders = stats
    .filter(user => user.duplicatesPosted > 0)
    .sort((a, b) => b.duplicatesPosted - a.duplicatesPosted);
  
  if (duplicateOffenders.length > 0) {
    for (let i = 0; i < Math.min(3, duplicateOffenders.length); i++) {
      const user = duplicateOffenders[i];
      statsMessage += `${i+1}. ${user.username || user.userId}: ${user.duplicatesPosted} duplicates\n`;
    }
  } else {
    statsMessage += 'No duplicates posted this week! 🎉\n';
  }
  
  return statsMessage;
}

// Check if the chat is a group or supergroup
async function isGroup(chatId) {
  try {
    const chat = await bot.getChat(chatId);
    return chat.type === 'group' || chat.type === 'supergroup';
  } catch (error) {
    console.error('Error checking chat type:', error);
    return false;
  }
}

// Check if the user is an admin in the group
async function isAdmin(chatId, userId) {
  try {
    const chatMember = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(chatMember.status);
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// Start listening for messages
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
    
    // Only process messages from groups
    const isValidGroup = await isGroup(chatId);
    if (!isValidGroup) {
      // If it's a private chat, still allow commands but not media processing
      if (msg.text && msg.text.startsWith('/')) {
        // Process commands in private chats
      } else {
        return; // Not a command in a private chat, ignore
      }
    }
    
    // If a specific group ID is set, use it for logging but don't restrict functionality
    if (groupId) {
      console.log(`Processing message in chat ${chatId}, configured group is ${groupId}`);
    }
    
    // Check for commands
    if (msg.text && msg.text.startsWith('/')) {
      const command = msg.text.split(' ')[0].substring(1);
      
      // Handle stats command - allow anyone to use it
      if (command === 'stats') {
        const statsMessage = await generateWeeklyStats();
        await bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
        return;
      }
      
      // Handle help command
      if (command === 'help') {
        const helpMessage = `*Duplicate Detector Bot*\n\n`+
                          `This bot detects duplicate media in the group and tracks user statistics.\n\n`+
                          `*Commands:*\n`+
                          `/stats - Get group statistics\n`+
                          `/help - Show this help message`;
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
        return;
      }
    }
    
    // Handle media messages (images, videos, gifs)
    if (msg.photo || msg.video || msg.document) {
      let mediaFileId;
      let mediaType;
      
      if (msg.photo) {
        mediaFileId = msg.photo[msg.photo.length - 1].file_id; // Get the highest resolution photo
        mediaType = 'photo';
      } else if (msg.video) {
        mediaFileId = msg.video.file_id;
        mediaType = 'video';
      } else if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
        mediaFileId = msg.document.file_id;
        mediaType = 'document';
      }
      
      if (mediaFileId) {
        // Get file path
        const fileInfo = await bot.getFile(mediaFileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
        
        // Download the file
        const response = await fetch(fileUrl);
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        
        // Generate perceptual hash for the media
        const mediaHash = await hashMedia(mediaBuffer, mediaType);
        
        // Check for similar media in the database using perceptual hash
        const db = client.db(dbName);
        const existingMedia = await findSimilarMedia(mediaHash, mediaType);
        
        if (existingMedia) {
          // Duplicate found
          let posterMention;
          if (existingMedia.username && !existingMedia.username.includes(' ')) {
            posterMention = `@${existingMedia.username}`;
          } else {
            posterMention = existingMedia.username || existingMedia.userId;
          }
          const postDate = new Date(existingMedia.timestamp).toLocaleDateString();
          await bot.sendMessage(
            chatId, 
            `⚠️ <b>Duplicate Content Detected</b> ⚠️\n\nThis ${mediaType} has already been posted by ${posterMention} on ${postDate}.`,
            { parse_mode: 'HTML', reply_to_message_id: msg.message_id }
          );
          
          // Track this duplicate
          await trackDuplicate(userId, username);
        } else {
          // Store the new media hash and metadata
          await db.collection('media').insertOne({
            hash: mediaHash,
            originalMessageId: msg.message_id,
            userId,
            username,
            mediaType,
            timestamp: new Date(),
            chatId
          });
          
          // Update user statistics
          await updateUserStatistics(userId, username, mediaType);
        }
      }
    } else if (msg.text && !msg.text.startsWith('/')) {
      // Handle regular text messages (not commands)
      await updateUserStatistics(userId, username, 'text');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Schedule weekly statistics post (Sunday at 12:00 PM)
cron.schedule('0 12 * * 0', async () => {
  try {
    // Get all unique chat IDs from the database where messages were processed
    const db = client.db(dbName);
    const uniqueChats = await db.collection('media').distinct('chatId');
    
    // Post to all groups where the bot has been active
    if (uniqueChats.length > 0) {
      console.log(`Found ${uniqueChats.length} chats to post statistics to`);
      
      for (const chatId of uniqueChats) {
        try {
          // Check if the chat is a group or supergroup
          const chat = await bot.getChat(chatId);
          if (chat.type === 'group' || chat.type === 'supergroup') {
            // Generate stats specific to this chat for proper mentions
            const statsMessage = await generateWeeklyStats(chatId);
            await bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
            console.log(`Weekly statistics posted to group: ${chatId}`);
          }
        } catch (err) {
          console.error(`Failed to post statistics to chat ${chatId}:`, err.message);
        }
      }
    } else {
      console.log('No active chats found to post statistics to');
    }
    
    // If a specific group ID is set and it's not in the unique chats, post there too
    if (groupId && !uniqueChats.includes(parseInt(groupId)) && !uniqueChats.includes(groupId)) {
      try {
        const statsMessage = await generateWeeklyStats(groupId);
        await bot.sendMessage(groupId, statsMessage, { parse_mode: 'HTML' });
        console.log(`Weekly statistics posted to configured group: ${groupId}`);
      } catch (err) {
        console.error(`Failed to post statistics to configured group ${groupId}:`, err.message);
      }
    }
    
    console.log('Weekly statistics posting completed');
  } catch (error) {
    console.error('Error posting weekly statistics:', error);
  }
});

// Start the bot
connectToDatabase().then(() => {
  console.log('Bot is running...');
  if (groupId) {
    console.log(`Bot is configured for group: ${groupId}`);
  } else {
    console.log('Bot will work in any group it is added to');
  }
}).catch(error => {
  console.error('Failed to start the bot:', error);
});