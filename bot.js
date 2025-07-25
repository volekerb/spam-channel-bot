const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const imageHash = require('image-hash');
const express = require('express');
const bodyParser = require('body-parser');

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
// Use webhook in production, polling in development
const useWebhook = process.env.NODE_ENV === 'production' || process.env.USE_WEBHOOK === 'true';
const webhookUrl = process.env.WEBHOOK_URL; // Your Railway app URL + /webhook

let bot;
if (useWebhook && webhookUrl) {
  bot = new TelegramBot(token, { webHook: true });
  console.log('Bot initialized in webhook mode');
} else {
  bot = new TelegramBot(token, { polling: true });
  console.log('Bot initialized in polling mode');
}

// MongoDB client
const client = new MongoClient(mongoUri);
const dbName = 'duplicate_detector';

// Express app for webhook
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Webhook endpoint
if (useWebhook && webhookUrl) {
  // Set webhook with error handling
  bot.setWebHook(`${webhookUrl}/webhook`, {
    allowed_updates: ['message', 'message_reaction', 'message_reaction_count', 'chat_member']
  })
    .then(() => {
      console.log(`✅ Webhook successfully set to: ${webhookUrl}/webhook`);
      console.log('✅ Webhook configured to receive reaction updates');
    })
    .catch((error) => {
      console.error('❌ Error setting webhook:', error);
    });
  
  // Webhook route
  app.post('/webhook', (req, res) => {
    try {
      const updateType = Object.keys(req.body).find(key => key !== 'update_id');
      console.log(`🔄 Received update type: ${updateType}`);
      
      // Log reaction updates specifically
      if (updateType === 'message_reaction' || updateType === 'message_reaction_count') {
        console.log('😍 Reaction update received:', JSON.stringify(req.body, null, 2));
      }
      
      bot.processUpdate(req.body);
    } catch (error) {
      console.error('❌ Error processing webhook update:', error);
    }
    
    res.sendStatus(200);
  });
  
  // Webhook info endpoint for debugging
  app.get('/webhook-info', async (req, res) => {
    try {
      const info = await bot.getWebHookInfo();
      res.json(info);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start Express server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

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
        // Save buffer to a temporary file since image-hash requires a file path
        const tempFilePath = path.join(downloadsDir, `temp_${Date.now()}.jpg`);
        
        // Write the buffer to a temporary file
        fs.writeFileSync(tempFilePath, media);
        
        // Use image-hash with the file path
        imageHash.imageHash(tempFilePath, 16, true, (error, hash) => {
          // Clean up the temporary file
          try {
            fs.unlinkSync(tempFilePath);
          } catch (cleanupError) {
            console.error('Error cleaning up temp file:', cleanupError);
          }
          
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

// HTML escape function for proper HTML parse mode
function escapeHtml(text) {
  if (!text) return '';
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  await db.collection('duplicates').insertOne({
    userId,
    username,
    timestamp: new Date()
  });
}

// Generate weekly statistics
async function generateWeeklyStats() {
  const db = client.db(dbName);
  
  // Calculate date range for the past week
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  let statsMessage = '📊 <b>Weekly Channel Statistics</b> 📊\n\n';
  
  // Get weekly media posts
  const weeklyMedia = await db.collection('media').find({
    timestamp: { $gte: oneWeekAgo }
  }).toArray();
  
  // Get weekly user statistics
  const userWeeklyStats = {};
  const userReactionStats = {};
  
  for (const media of weeklyMedia) {
    const userId = media.userId;
    const username = media.username || userId;
    
    if (!userWeeklyStats[userId]) {
      userWeeklyStats[userId] = {
        userId,
        username,
        photoCount: 0,
        videoCount: 0,
        documentCount: 0,
        totalMessages: 0
      };
    }
    
    userWeeklyStats[userId][`${media.mediaType}Count`]++;
    userWeeklyStats[userId].totalMessages++;
    
    // Get reaction count for this media post
    const reactionCount = await getMessageReactions(media.chatId, media.originalMessageId);
    console.log(`🔍 [Weekly Stats] Checking reactions for media: chatId=${media.chatId}, messageId=${media.originalMessageId}, reactions=${reactionCount}`);
    
    // Track reactions for "Петушок недели"
    if (reactionCount > 0) {
      console.log(`✅ [Weekly Stats] Found ${reactionCount} reactions for user ${media.username} (${media.userId})`);
      if (!userReactionStats[userId]) {
        userReactionStats[userId] = {
          userId,
          username,
          totalReactions: 0
        };
      }
      userReactionStats[userId].totalReactions += reactionCount;
    }
  }
  
  // Get weekly text messages (non-media)
  const weeklyTextMessages = await db.collection('textMessages').find({
    timestamp: { $gte: oneWeekAgo }
  }).toArray();
  
  for (const textMsg of weeklyTextMessages) {
    const userId = textMsg.userId;
    const username = textMsg.username || userId;
    
    if (!userWeeklyStats[userId]) {
      userWeeklyStats[userId] = {
        userId,
        username,
        photoCount: 0,
        videoCount: 0,
        documentCount: 0,
        textCount: 0,
        totalMessages: 0
      };
    }
    
    userWeeklyStats[userId].textCount = (userWeeklyStats[userId].textCount || 0) + 1;
    userWeeklyStats[userId].totalMessages++;
  }
  
  const weeklyStatsArray = Object.values(userWeeklyStats);
  
  // Sort users by total messages for top contributors
  weeklyStatsArray.sort((a, b) => b.totalMessages - a.totalMessages);
  
  // Top contributors
  statsMessage += '<b>Top Contributors:</b>\n';
  for (let i = 0; i < Math.min(5, weeklyStatsArray.length); i++) {
    const user = weeklyStatsArray[i];
    const displayName = user.username && !user.username.includes(' ') ? `@${user.username}` : (user.username || user.userId);
    statsMessage += `${i+1}. ${escapeHtml(displayName)}: ${user.totalMessages} messages\n`;
  }
  
  // Петушок недели (Top reactor)
  const reactionStatsArray = Object.values(userReactionStats);
  if (reactionStatsArray.length > 0) {
    reactionStatsArray.sort((a, b) => b.totalReactions - a.totalReactions);
    const topReactor = reactionStatsArray[0];
    const displayName = topReactor.username && !topReactor.username.includes(' ') ? `@${topReactor.username}` : (topReactor.username || topReactor.userId);
    statsMessage += `\n🐓 <b>Петушок недели:</b>\n${escapeHtml(displayName)} с ${topReactor.totalReactions} реакциями\n`;
  }
  
  // Media breakdown
  const totalPhotos = weeklyStatsArray.reduce((sum, user) => sum + (user.photoCount || 0), 0);
  const totalVideos = weeklyStatsArray.reduce((sum, user) => sum + (user.videoCount || 0), 0);
  const totalTexts = weeklyStatsArray.reduce((sum, user) => sum + (user.textCount || 0), 0);
  
  statsMessage += '\n<b>Media Breakdown:</b>\n';
  statsMessage += `📷 Photos: ${totalPhotos}\n`;
  statsMessage += `🎬 Videos: ${totalVideos}\n`;
  statsMessage += `💬 Text Messages: ${totalTexts}\n`;
  
  // Weekly duplicate offenders
  const weeklyDuplicates = await db.collection('duplicates').find({
    timestamp: { $gte: oneWeekAgo }
  }).toArray();
  
  const duplicateStats = {};
  for (const duplicate of weeklyDuplicates) {
    const userId = duplicate.userId;
    const username = duplicate.username || userId;
    
    if (!duplicateStats[userId]) {
      duplicateStats[userId] = {
        userId,
        username,
        count: 0
      };
    }
    duplicateStats[userId].count++;
  }
  
  const duplicateOffenders = Object.values(duplicateStats)
    .filter(user => user.count > 0)
    .sort((a, b) => b.count - a.count);
  
  statsMessage += '\n<b>Duplicate Offenders:</b>\n';
  if (duplicateOffenders.length > 0) {
    for (let i = 0; i < Math.min(3, duplicateOffenders.length); i++) {
      const user = duplicateOffenders[i];
      const displayName = user.username && !user.username.includes(' ') ? `@${user.username}` : (user.username || user.userId);
      statsMessage += `${i+1}. ${escapeHtml(displayName)}: ${user.count} duplicates\n`;
    }
  } else {
    statsMessage += 'No duplicates posted this week! 🎉\n';
  }
  
  return statsMessage;
}

// Generate Петушок недели stats only
async function generatePetushokStats() {
  const db = client.db(dbName);
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  // Get weekly media posts
  const weeklyMedia = await db.collection('media').find({
    timestamp: { $gte: oneWeekAgo }
  }).toArray();
  
  const userReactionStats = {};
  
  // Calculate reaction stats for each user
  for (const media of weeklyMedia) {
    const userId = media.userId;
    const username = media.username || userId;
    
    // Get reaction count for this media post
    const reactionCount = await getMessageReactions(media.chatId, media.originalMessageId);
    console.log(`🔍 [Petushok Stats] Checking reactions for media: chatId=${media.chatId}, messageId=${media.originalMessageId}, reactions=${reactionCount}`);
    
    // Track reactions for "Петушок недели"
    if (reactionCount > 0) {
      console.log(`✅ [Petushok Stats] Found ${reactionCount} reactions for user ${media.username} (${media.userId})`);
      if (!userReactionStats[userId]) {
        userReactionStats[userId] = {
          userId,
          username,
          totalReactions: 0
        };
      }
      userReactionStats[userId].totalReactions += reactionCount;
    }
  }
  
  let petushokMessage = '🐓 <b>Петушок недели</b> 🐓\n\n';
  
  // Find top reactor
  const reactionStatsArray = Object.values(userReactionStats);
  if (reactionStatsArray.length > 0) {
    reactionStatsArray.sort((a, b) => b.totalReactions - a.totalReactions);
    const topReactor = reactionStatsArray[0];
    const displayName = topReactor.username && !topReactor.username.includes(' ') ? `@${topReactor.username}` : (topReactor.username || topReactor.userId);
    petushokMessage += `${escapeHtml(displayName)} с ${topReactor.totalReactions} реакциями за неделю! 🎉`;
  } else {
    petushokMessage += 'Пока никто не получил реакций на свои посты на этой неделе 😔';
  }
  
  return petushokMessage;
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
    const db = client.db(dbName);
    
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
      
      // Handle petushok command - allow anyone to use it
      if (command === 'petushok') {
        const petushokMessage = await generatePetushokStats();
        await bot.sendMessage(chatId, petushokMessage, { parse_mode: 'HTML' });
        return;
      }
      
      // Handle help command
      if (command === 'help') {
        const helpMessage = `*Duplicate Detector Bot*\n\n`+
                          `This bot detects duplicate media in the group and tracks user statistics.\n\n`+
                          `*Commands:*\n`+
                          `/stats - Get group statistics\n`+
                          `/petushok - Get Петушок недели (top reactor)\n`+
                          `/debug_reactions - Check reaction tracking status\n`+
                          `/webhook_info - Check webhook configuration\n`+
                          `/group_info - Check group type and bot permissions\n`+
                          `/help - Show this help message`;
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
        return;
      }
      
      // Debug command to check reaction tracking
      if (command === 'debug_reactions') {
        try {
          const db = client.db(dbName);
          const reactionCount = await db.collection('messageReactions').countDocuments();
          const recentReactions = await db.collection('messageReactions')
            .find({})
            .sort({ lastUpdated: -1 })
            .limit(5)
            .toArray();
          
          let debugMessage = `<b>🔍 Reaction Tracking Debug</b>\n\n`;
          debugMessage += `📊 Total reactions in DB: ${reactionCount}\n\n`;
          
          if (recentReactions.length > 0) {
            debugMessage += `<b>Recent reactions:</b>\n`;
            recentReactions.forEach((reaction, index) => {
              debugMessage += `${index + 1}. Chat: ${reaction.chatId}, Message: ${reaction.messageId}, Reactions: ${reaction.totalReactions}\n`;
            });
          } else {
            debugMessage += `❌ No reactions found in database\n`;
            debugMessage += `This could mean:\n`;
            debugMessage += `• Webhook not receiving reaction updates\n`;
            debugMessage += `• Bot not admin with proper permissions\n`;
            debugMessage += `• Group type doesn't support reactions\n`;
          }
          
          await bot.sendMessage(chatId, debugMessage, { parse_mode: 'HTML' });
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Error checking reactions: ${error.message}`);
        }
        return;
      }
      
      // Debug command to check webhook info
      if (command === 'webhook_info') {
        try {
          const webhookInfo = await bot.getWebHookInfo();
          let infoMessage = `<b>🔗 Webhook Information</b>\n\n`;
          infoMessage += `URL: ${webhookInfo.url || 'Not set'}\n`;
          infoMessage += `Pending updates: ${webhookInfo.pending_update_count || 0}\n`;
          infoMessage += `Max connections: ${webhookInfo.max_connections || 'Default'}\n`;
          infoMessage += `Allowed updates: ${webhookInfo.allowed_updates ? webhookInfo.allowed_updates.join(', ') : 'All'}\n`;
          
          if (webhookInfo.last_error_date) {
            infoMessage += `\n❌ Last error: ${webhookInfo.last_error_message}\n`;
            infoMessage += `Error date: ${new Date(webhookInfo.last_error_date * 1000).toLocaleString()}\n`;
          } else {
            infoMessage += `\n✅ No recent errors\n`;
          }
          
          await bot.sendMessage(chatId, infoMessage, { parse_mode: 'HTML' });
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Error getting webhook info: ${error.message}`);
        }
        return;
      }
      
      // Debug command to check group info and bot permissions
      if (command === 'group_info') {
        try {
          const chat = await bot.getChat(chatId);
          const botInfo = await bot.getMe();
          const botMember = await bot.getChatMember(chatId, botInfo.id);
          
          let groupMessage = `<b>👥 Group Information</b>\n\n`;
          groupMessage += `Type: ${chat.type}\n`;
          groupMessage += `Title: ${escapeHtml(chat.title || 'N/A')}\n`;
          groupMessage += `Members: ${chat.members_count || 'Unknown'}\n\n`;
          
          groupMessage += `<b>🤖 Bot Status</b>\n`;
          groupMessage += `Status: ${botMember.status}\n`;
          
          if (botMember.status === 'administrator') {
            groupMessage += `Can read all messages: ${botMember.can_read_all_group_messages ? '✅' : '❌'}\n`;
            groupMessage += `Can delete messages: ${botMember.can_delete_messages ? '✅' : '❌'}\n`;
          } else if (botMember.status === 'member') {
            groupMessage += `\n⚠️ Bot is not admin - reactions may not work\n`;
          }
          
          groupMessage += `\n<b>📱 Reaction Support</b>\n`;
          if (chat.type === 'supergroup') {
            groupMessage += `✅ Supergroup - reactions supported\n`;
          } else if (chat.type === 'group') {
            groupMessage += `⚠️ Regular group - limited reaction support\n`;
          } else {
            groupMessage += `❌ Not a group - reactions not supported\n`;
          }
          
          await bot.sendMessage(chatId, groupMessage, { parse_mode: 'HTML' });
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Error getting group info: ${error.message}`);
        }
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
        const existingMedia = await findSimilarMedia(mediaHash, mediaType);
        
        if (existingMedia) {
          // Duplicate found
          let posterMention;
          if (existingMedia.username && !existingMedia.username.includes(' ')) {
            posterMention = `@${existingMedia.username}`;
          } else {
            posterMention = existingMedia.username || existingMedia.userId;
          }
          // Format date as dd.mm.yyyy
          const date = new Date(existingMedia.timestamp);
          const postDate = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
          
          // Create link to original message
          const originalMessageLink = `https://t.me/c/${Math.abs(chatId).toString().slice(3)}/${existingMedia.originalMessageId}`;
          
          await bot.sendMessage(
            chatId, 
            `⚠️ <b>Duplicate Content Detected</b> ⚠️\n\nThis ${mediaType} has already been posted by ${posterMention} on ${postDate}.\n\n📎 <a href="${originalMessageLink}">View original message</a>`,
            { parse_mode: 'HTML', reply_to_message_id: msg.message_id, disable_web_page_preview: true }
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
      
      // Store text message for weekly tracking
      await db.collection('textMessages').insertOne({
        userId,
        username,
        messageId: msg.message_id,
        timestamp: new Date(),
        chatId
      });
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Function to get stored reaction count for a message
async function getMessageReactions(chatId, messageId) {
  try {
    const db = client.db(dbName);
    const reactionData = await db.collection('messageReactions').findOne({
      chatId: chatId.toString(),
      messageId: messageId.toString()
    });
    
    return reactionData ? reactionData.totalReactions : 0;
  } catch (error) {
    console.error('Error getting message reactions:', error);
    return 0;
  }
}

// Function to update reaction count in database
async function updateMessageReactions(chatId, messageId, reactions) {
  try {
    const db = client.db(dbName);
    
    // Calculate total reactions properly
    // reactions is an array of reaction objects with counts
    let totalReactions = 0;
    if (Array.isArray(reactions)) {
      totalReactions = reactions.reduce((sum, reaction) => {
        // Handle both individual reactions and reaction count objects
        if (reaction.total_count) {
          return sum + reaction.total_count; // From message_reaction_count
        } else {
          return sum + 1; // From message_reaction (individual)
        }
      }, 0);
    }
    
    console.log(`📊 Updating reactions for message ${messageId}: ${totalReactions} total reactions`);
    
    await db.collection('messageReactions').updateOne(
      {
        chatId: chatId.toString(),
        messageId: messageId.toString()
      },
      {
        $set: {
          totalReactions,
          reactions: reactions,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error updating message reactions:', error);
  }
}

// Handle message reaction updates
bot.on('message_reaction', async (update) => {
  try {
    console.log('😍 [message_reaction] Reaction update received:', JSON.stringify(update, null, 2));
    
    const chatId = update.chat.id;
    const messageId = update.message_id;
    const newReaction = update.new_reaction || [];
    const oldReaction = update.old_reaction || [];
    
    console.log(`📝 [message_reaction] Processing: chatId=${chatId}, messageId=${messageId}`);
    console.log(`📝 [message_reaction] Old reactions: ${oldReaction.length}, New reactions: ${newReaction.length}`);
    
    // Update reaction count in database
    await updateMessageReactions(chatId, messageId, newReaction);
    
    console.log(`✅ [message_reaction] Updated reactions for message ${messageId} in chat ${chatId}`);
    
  } catch (error) {
    console.error('❌ [message_reaction] Error processing reaction update:', error);
  }
});

// Handle message reaction count updates (alternative event)
bot.on('message_reaction_count', async (update) => {
  try {
    console.log('📊 [message_reaction_count] Reaction count update received:', JSON.stringify(update, null, 2));
    
    const chatId = update.chat.id;
    const messageId = update.message_id;
    const reactions = update.reactions || [];
    
    console.log(`📝 [message_reaction_count] Processing: chatId=${chatId}, messageId=${messageId}`);
    console.log(`📝 [message_reaction_count] Reactions array:`, reactions);
    
    // Calculate total reaction count
    const totalReactions = reactions.reduce((sum, reaction) => sum + reaction.total_count, 0);
    
    console.log(`📊 [message_reaction_count] Calculated total: ${totalReactions}`);
    
    // Update in database
    const db = client.db(dbName);
    await db.collection('messageReactions').updateOne(
      {
        chatId: chatId.toString(),
        messageId: messageId.toString()
      },
      {
        $set: {
          totalReactions,
          reactions,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );
    
    console.log(`✅ [message_reaction_count] Updated reaction count for message ${messageId}: ${totalReactions} total reactions`);
    
  } catch (error) {
    console.error('❌ [message_reaction_count] Error processing reaction count update:', error);
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