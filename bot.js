const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Use environment variables for sensitive information (Railway automatically provides these)
const token = process.env.TELEGRAM_BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI || process.env.DATABASE_URL; // Railway provides DATABASE_URL for MongoDB
const channelId = process.env.TELEGRAM_CHANNEL_ID;

// Validate required environment variables
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

if (!mongoUri) {
  console.error('MONGODB_URI or DATABASE_URL environment variable is not set');
  process.exit(1);
}

if (!channelId) {
  console.error('TELEGRAM_CHANNEL_ID environment variable is not set');
  process.exit(1);
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

// Function to hash media files
const hashMedia = (media) => {
  const hash = crypto.createHash('sha256');
  hash.update(media);
  return hash.digest('hex');
};

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

// Start listening for messages
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
    
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
        const mediaHash = hashMedia(mediaBuffer);
        
        // Check for duplicates in the database
        const db = client.db(dbName);
        const existingMedia = await db.collection('media').findOne({ hash: mediaHash });
        
        if (existingMedia) {
          // Duplicate found
          await bot.sendMessage(
            chatId, 
            `⚠️ *Duplicate Content Detected* ⚠️\n\nThis ${mediaType} has already been posted by ${existingMedia.username || existingMedia.userId} on ${new Date(existingMedia.timestamp).toLocaleDateString()}.`,
            { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
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
    } else if (msg.text) {
      // Handle text messages
      await updateUserStatistics(userId, username, 'text');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Schedule weekly statistics post (Sunday at 12:00 PM)
cron.schedule('0 12 * * 0', async () => {
  try {
    const statsMessage = await generateWeeklyStats();
    
    // Post to the channel using the channelId from environment variables
    await bot.sendMessage(channelId, statsMessage, { parse_mode: 'Markdown' });
    
    console.log('Weekly statistics posted successfully');
  } catch (error) {
    console.error('Error posting weekly statistics:', error);
  }
});

// Start the bot
connectToDatabase().then(() => {
  console.log('Bot is running...');
  console.log(`Weekly statistics will be posted to channel: ${channelId}`);
}).catch(error => {
  console.error('Failed to start the bot:', error);
});