// WhatsApp Bot with Google Sheets Auto-Reply
// Dependencies: npm install whatsapp-web.js googleapis qrcode-terminal

const { Client, LocalAuth } = require('whatsapp-web.js');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');

class WhatsAppBot {
    constructor(config) {
        this.config = config;
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: { headless: true }
        });
        this.sheets = null;
        this.responses = new Map();
        this.initializeGoogleSheets();
        this.setupWhatsAppClient();
    }

    // Initialize Google Sheets API
    async initializeGoogleSheets() {
        try {
            const auth = new google.auth.GoogleAuth({
                keyFile: this.config.googleAuth.keyFile,
                scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
            });
            
            this.sheets = google.sheets({ version: 'v4', auth });
            console.log('Google Sheets API initialized successfully');
            
            // Load initial responses
            await this.loadResponses();
            
            // Set up periodic refresh
            setInterval(() => this.loadResponses(), this.config.refreshInterval || 60000);
        } catch (error) {
            console.error('Error initializing Google Sheets:', error);
        }
    }

    // Load responses from Google Sheets
    async loadResponses() {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.config.spreadsheetId,
                range: this.config.range || 'Sheet1!A:B'
            });

            const rows = response.data.values;
            if (rows && rows.length > 0) {
                this.responses.clear();
                
                // Skip header row if exists
                const startRow = this.config.hasHeader ? 1 : 0;
                
                for (let i = startRow; i < rows.length; i++) {
                    const [keyword, reply] = rows[i];
                    if (keyword && reply) {
                        this.responses.set(keyword.toLowerCase().trim(), reply.trim());
                    }
                }
                
                console.log(`Loaded ${this.responses.size} auto-reply responses`);
            }
        } catch (error) {
            console.error('Error loading responses from Google Sheets:', error);
        }
    }

    // Setup WhatsApp client event handlers
    setupWhatsAppClient() {
        this.client.on('qr', (qr) => {
            console.log('Scan the QR code below with WhatsApp:');
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            console.log('WhatsApp client is ready!');
        });

        this.client.on('authenticated', () => {
            console.log('WhatsApp client authenticated');
        });

        this.client.on('message', async (message) => {
            await this.handleMessage(message);
        });

        this.client.on('disconnected', (reason) => {
            console.log('WhatsApp client disconnected:', reason);
        });
    }

    // Handle incoming messages
    async handleMessage(message) {
        try {
            // Skip if message is from status broadcast
            if (message.from === 'status@broadcast') return;
            
            // Skip if message is from self
            if (message.fromMe) return;

            const messageBody = message.body.toLowerCase().trim();
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            // Check if message is from group
            const isGroup = chat.isGroup;
            const groupName = isGroup ? chat.name : 'Direct Message';
            
            console.log(`Message from ${contact.name || contact.pushname} in ${groupName}: ${message.body}`);

            // Group message handling
            if (isGroup) {
                // Check if bot should respond in this group
                if (!this.shouldRespondInGroup(chat, message)) {
                    return;
                }
                
                // Log group activity
                console.log(`Group: ${chat.name} | Members: ${chat.participants.length}`);
            }

            // Check for exact keyword match first
            let reply = this.responses.get(messageBody);
            
            // If no exact match, check for partial matches
            if (!reply) {
                for (const [keyword, response] of this.responses.entries()) {
                    if (messageBody.includes(keyword)) {
                        reply = response;
                        break;
                    }
                }
            }

            // Send reply if found
            if (reply) {
                // Replace placeholders with dynamic content
                reply = this.processDynamicContent(reply, contact, message, chat);
                
                await message.reply(reply);
                console.log(`Auto-replied in ${groupName}: ${reply}`);
            } else if (this.config.defaultReply && this.shouldSendDefaultReply(chat)) {
                await message.reply(this.config.defaultReply);
                console.log(`Sent default reply in ${groupName}: ${this.config.defaultReply}`);
            }

        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    // Check if bot should respond in this group
    shouldRespondInGroup(chat, message) {
        // Option 1: Only respond when mentioned with @
        if (this.config.groupSettings.respondOnlyWhenMentioned) {
            return message.mentionedIds.length > 0;
        }
        
        // Option 2: Only respond to specific groups
        if (this.config.groupSettings.allowedGroups.length > 0) {
            return this.config.groupSettings.allowedGroups.includes(chat.id._serialized);
        }
        
        // Option 3: Only respond to admins
        if (this.config.groupSettings.adminOnly) {
            const participant = chat.participants.find(p => p.id._serialized === message.author);
            return participant && participant.isAdmin;
        }
        
        // Option 4: Respond to all messages (default)
        return this.config.groupSettings.respondToAll;
    }

    // Check if default reply should be sent
    shouldSendDefaultReply(chat) {
        if (chat.isGroup) {
            return this.config.groupSettings.sendDefaultReplyInGroups;
        }
        return true; // Always send default reply in direct messages
    }

    // Process dynamic content in replies
    processDynamicContent(reply, contact, message, chat) {
        const now = new Date();
        const replacements = {
            '{name}': contact.name || contact.pushname || 'there',
            '{time}': now.toLocaleTimeString(),
            '{date}': now.toLocaleDateString(),
            '{phone}': contact.number,
            '{message}': message.body,
            '{group}': chat.isGroup ? chat.name : 'Direct Message',
            '{memberCount}': chat.isGroup ? chat.participants.length.toString() : '1'
        };

        let processedReply = reply;
        for (const [placeholder, value] of Object.entries(replacements)) {
            processedReply = processedReply.replace(new RegExp(placeholder, 'g'), value);
        }

        return processedReply;
    }

    // Start the bot
    async start() {
        try {
            await this.client.initialize();
            console.log('WhatsApp bot started successfully');
        } catch (error) {
            console.error('Error starting WhatsApp bot:', error);
        }
    }

    // Stop the bot
    async stop() {
        try {
            await this.client.destroy();
            console.log('WhatsApp bot stopped');
        } catch (error) {
            console.error('Error stopping WhatsApp bot:', error);
        }
    }

    // Add new response (for future expansion)
    async addResponse(keyword, reply) {
        this.responses.set(keyword.toLowerCase().trim(), reply.trim());
        console.log(`Added new response: ${keyword} -> ${reply}`);
    }

    // Get all responses
    getResponses() {
        return Array.from(this.responses.entries());
    }

    // Get bot statistics
    getStats() {
        return {
            totalResponses: this.responses.size,
            isConnected: this.client.pupPage !== null,
            lastUpdate: new Date().toISOString()
        };
    }

    // Group management methods
    async getGroupList() {
        const chats = await this.client.getChats();
        return chats.filter(chat => chat.isGroup).map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            participants: chat.participants.length,
            description: chat.description || 'No description'
        }));
    }

    async addToAllowedGroups(groupId) {
        if (!this.config.groupSettings.allowedGroups.includes(groupId)) {
            this.config.groupSettings.allowedGroups.push(groupId);
            console.log(`Added group ${groupId} to allowed groups`);
        }
    }

    async removeFromAllowedGroups(groupId) {
        const index = this.config.groupSettings.allowedGroups.indexOf(groupId);
        if (index > -1) {
            this.config.groupSettings.allowedGroups.splice(index, 1);
            console.log(`Removed group ${groupId} from allowed groups`);
        }
    }

    async sendToGroup(groupId, message) {
        try {
            const chat = await this.client.getChatById(groupId);
            if (chat.isGroup) {
                await chat.sendMessage(message);
                console.log(`Sent message to group ${chat.name}: ${message}`);
            }
        } catch (error) {
            console.error('Error sending message to group:', error);
        }
    }

    // Broadcast message to all allowed groups
    async broadcastToGroups(message) {
        const allowedGroups = this.config.groupSettings.allowedGroups;
        for (const groupId of allowedGroups) {
            await this.sendToGroup(groupId, message);
        }
    }
}

// Load environment variables
require('dotenv').config();

// Configuration object
const config = {
    // Google Sheets configuration
    googleAuth: {
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json'
    },
    spreadsheetId: process.env.SPREADSHEET_ID || 'your-spreadsheet-id-here',
    range: process.env.SHEET_RANGE || 'Sheet1!A:B',
    hasHeader: true,
    
    // Bot configuration
    refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 60000,
    defaultReply: process.env.DEFAULT_REPLY || null,
    
    // Group settings
    groupSettings: {
        respondToAll: process.env.RESPOND_TO_ALL === 'true' || true,
        respondOnlyWhenMentioned: process.env.RESPOND_ONLY_WHEN_MENTIONED === 'true' || false,
        adminOnly: process.env.ADMIN_ONLY === 'true' || false,
        allowedGroups: process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',') : [],
        sendDefaultReplyInGroups: process.env.SEND_DEFAULT_REPLY_IN_GROUPS === 'true' || false,
        maxGroupMessages: parseInt(process.env.MAX_GROUP_MESSAGES) || 50
    },
    
    // Advanced options
    caseSensitive: process.env.CASE_SENSITIVE === 'true' || false,
    partialMatch: process.env.PARTIAL_MATCH === 'true' || true
};

// Usage example
const bot = new WhatsAppBot(config);

// Start the bot
bot.start().then(() => {
    console.log('Bot initialization complete');
}).catch(error => {
    console.error('Failed to start bot:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down bot...');
    await bot.stop();
    process.exit(0);
});

// Export for use as module
module.exports = WhatsAppBot;