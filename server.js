require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Keep login session for 7 days
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const DB_FILE = path.join(__dirname, 'applications.json');

function getDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({}));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// In-memory states managed via Discord commands
let isApplicationsOpen = true;
// blacklistedUsers store format: { userId: { reason, expiresAt (timestamp or null) } }
let blacklistedUsers = {};

// Helper to parse duration strings like "30s", "15m", "2h", "7d", "2w", "1d12h30m"
function parseDuration(str) {
    if (!str) return null;
    const regex = /(\d+)\s*([smdw])/g;
    let totalMs = 0;
    let match;
    let found = false;
    while ((match = regex.exec(str.toLowerCase())) !== null) {
        found = true;
        const val = parseInt(match[1]);
        const unit = match[2];
        if (unit === 's') totalMs += val * 1000;
        else if (unit === 'm') totalMs += val * 60 * 1000;
        else if (unit === 'h') totalMs += val * 60 * 60 * 1000;
        else if (unit === 'd') totalMs += val * 24 * 60 * 60 * 1000;
        else if (unit === 'w') totalMs += val * 7 * 24 * 60 * 60 * 1000;
    }
    return found ? totalMs : null;
}

// Helper to check and cleanup expired blacklists
function isUserBlacklisted(userId) {
    if (!blacklistedUsers[userId]) return false;
    const entry = blacklistedUsers[userId];
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
        delete blacklistedUsers[userId];
        return false;
    }
    return true;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', async () => {
    console.log(`🤖 Discord Bot logged in as ${client.user.tag}`);

    // Register Slash Commands
    const commands = [
        {
            name: 'applications',
            description: 'Open or close staff applications',
            options: [
                {
                    name: 'status',
                    type: 3, // STRING
                    description: 'Select status',
                    required: true,
                    choices: [
                        { name: 'Open Applications', value: 'open' },
                        { name: 'Close Applications', value: 'close' }
                    ]
                }
            ]
        },
        {
            name: 'blacklist',
            description: 'Manage users who are restricted from submitting applications',
            options: [
                {
                    name: 'add',
                    type: 1, // SUB_COMMAND
                    description: 'Add a user with an optional reason and custom duration',
                    options: [
                        { name: 'user', type: 6, description: 'Select target user', required: true },
                        { name: 'reason', type: 3, description: 'Reason for blacklist', required: false },
                        { name: 'duration', type: 3, description: 'Duration (e.g. 30s, 15m, 2h, 7d, 2w, 1d12h30m). Leave empty for permanent', required: false }
                    ]
                },
                {
                    name: 'remove',
                    type: 1, // SUB_COMMAND
                    description: 'Remove a user from the blacklist',
                    options: [
                        { name: 'user', type: 6, description: 'Select target user', required: true }
                    ]
                },
                {
                    name: 'check',
                    type: 1, // SUB_COMMAND
                    description: 'Check blacklist status, reason, and expiry time',
                    options: [
                        { name: 'user', type: 6, description: 'Select target user', required: true }
                    ]
                },
                {
                    name: 'list',
                    type: 1, // SUB_COMMAND
                    description: 'Display blacklisted users and their expiry times'
                }
            ]
        },
        {
            name: 'reset-applications',
            description: 'Reset/clear all submitted applications from the database'
        }
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Successfully registered application slash commands.');
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    // 1. Handle Button Actions (Accept / Reject)
    if (interaction.isButton()) {
        const [action, userId] = interaction.customId.split('_');
        const db = getDB();

        if (!db[userId]) {
            return interaction.reply({ content: '❌ Applicant data not found.', ephemeral: true });
        }

        if (action === 'accept') {
            db[userId].status = 'accepted';
            saveDB(db);

            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor(0x2ecc71)
                .setTitle("✅ Minecraft Staff Application Accepted");

            await interaction.update({ embeds: [newEmbed], components: [] });
            await interaction.followUp({ content: `✅ Applicant has been accepted successfully and notified on the website.`, ephemeral: true });
        } 
        else if (action === 'reject') {
            db[userId].status = 'rejected';
            saveDB(db);

            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor(0xe74c3c)
                .setTitle("❌ Minecraft Staff Application Rejected");

            await interaction.update({ embeds: [newEmbed], components: [] });
            await interaction.followUp({ content: `❌ Applicant has been rejected and status updated on the website.`, ephemeral: true });
        }
        return;
    }

    // 2. Handle Slash Commands
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'applications') {
        const status = interaction.options.getString('status');
        if (status === 'open') {
            isApplicationsOpen = true;
            await interaction.reply({ content: '🔓 **Applications are now OPEN!** Users can apply freely.', ephemeral: false });
        } else {
            isApplicationsOpen = false;
            await interaction.reply({ content: '🔒 **Applications are now CLOSED!** No new submissions are allowed.', ephemeral: false });
        }
    } 
    else if (interaction.commandName === 'reset-applications') {
        saveDB({});
        await interaction.reply({ content: '🧹 **All applications have been reset!** All users can now submit new applications.', ephemeral: false });
    }
    else if (interaction.commandName === 'blacklist') {
        const subCommand = interaction.options.getSubcommand();

        if (subCommand === 'add') {
            const targetUser = interaction.options.getUser('user');
            const reason = interaction.options.getString('reason') || 'No reason provided';
            const durationStr = interaction.options.getString('duration');

            let expiresAt = null;
            if (durationStr) {
                const durationMs = parseDuration(durationStr);
                if (!durationMs) {
                    return interaction.reply({ content: '❌ Invalid duration format! Use formats like: `30s`, `15m`, `2h`, `7d`, `2w`, or `1d12h30m`.', ephemeral: true });
                }
                expiresAt = Date.now() + durationMs;
            }

            blacklistedUsers[targetUser.id] = {
                reason: reason,
                expiresAt: expiresAt
            };

            const durationText = expiresAt ? `until <t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>)` : '**Permanent**';
            await interaction.reply({ 
                content: `🚫 **User blacklisted successfully!**\n• **User:** <@${targetUser.id}> (\`${targetUser.id}\`)\n• **Reason:** ${reason}\n• **Duration:** ${durationText}`, 
                ephemeral: false 
            });
        } 
        else if (subCommand === 'remove') {
            const targetUser = interaction.options.getUser('user');

            if (blacklistedUsers[targetUser.id]) {
                delete blacklistedUsers[targetUser.id];
                await interaction.reply({ content: `✅ **Blacklist removed for user:** <@${targetUser.id}>`, ephemeral: false });
            } else {
                await interaction.reply({ content: `⚠️ User <@${targetUser.id}> is not currently in the blacklist.`, ephemeral: true });
            }
        }
        else if (subCommand === 'check') {
            const targetUser = interaction.options.getUser('user');

            if (isUserBlacklisted(targetUser.id)) {
                const info = blacklistedUsers[targetUser.id];
                const durationText = info.expiresAt ? `<t:${Math.floor(info.expiresAt / 1000)}:F> (<t:${Math.floor(info.expiresAt / 1000)}:R>)` : 'Permanent';
                await interaction.reply({ 
                    content: `🔍 **Blacklist Details for <@${targetUser.id}>:**\n• **Status:** Blacklisted 🚫\n• **Reason:** ${info.reason}\n• **Expires:** ${durationText}`, 
                    ephemeral: true 
                });
            } else {
                await interaction.reply({ content: `✅ User <@${targetUser.id}> is **not blacklisted**.`, ephemeral: true });
            }
        }
        else if (subCommand === 'list') {
            // Clean expired entries first
            Object.keys(blacklistedUsers).forEach(id => isUserBlacklisted(id));

            const keys = Object.keys(blacklistedUsers);
            if (keys.length === 0) {
                return interaction.reply({ content: '📜 The blacklist is currently empty.', ephemeral: true });
            }

            let listText = '📜 **Current Blacklisted Users:**\n\n';
            keys.forEach((id, index) => {
                const info = blacklistedUsers[id];
                const exp = info.expiresAt ? `<t:${Math.floor(info.expiresAt / 1000)}:R>` : 'Permanent';
                listText += `${index + 1}. <@${id}> (\`${id}\`) | **Reason:** ${info.reason} | **Expires:** ${exp}\n`;
            });

            await interaction.reply({ content: listText, ephemeral: true });
        }
    }
});

client.login(process.env.BOT_TOKEN);

app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('index');
});

app.get('/auth/discord', (req, res) => {
    const clientId = process.env.CLIENT_ID;
    const redirectUri = process.env.CLIENT_REDIRECT_URI;
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.CLIENT_REDIRECT_URI,
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        req.session.user = userResponse.data;
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Error during Discord auth:', error.response?.data || error.message);
        res.redirect('/');
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    const db = getDB();
    const userId = req.session.user.id;
    const userApplication = db[userId] || null;

    res.render('dashboard', { 
        user: req.session.user, 
        application: userApplication,
        customError: null,
        isAppOpen: isApplicationsOpen 
    });
});

app.get('/apply', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }

    const userId = req.session.user.id;

    // 1. Check Blacklist dynamically
    if (isUserBlacklisted(userId)) {
        return res.render('dashboard', { 
            user: req.session.user, 
            application: null,
            customError: 'blacklisted',
            isAppOpen: isApplicationsOpen 
        });
    }

    // 2. Check if applications are closed dynamically
    if (!isApplicationsOpen) {
        return res.render('dashboard', { 
            user: req.session.user, 
            application: null,
            customError: 'closed',
            isAppOpen: isApplicationsOpen 
        });
    }

    const db = getDB();
    if (db[userId]) {
        return res.redirect('/dashboard');
    }

    res.render('apply', { user: req.session.user });
});

app.post('/submit-application', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).send('Unauthorized');
    }

    const user = req.session.user;
    const userId = user.id;

    // Check blacklist and application status
    if (isUserBlacklisted(userId) || !isApplicationsOpen) {
        return res.redirect('/dashboard');
    }

    const db = getDB();
    if (db[userId]) {
        return res.redirect('/dashboard');
    }

    const answers = req.body;
    const channelId = process.env.PENDING_CHANNEL_ID;

    try {
        const targetChannel = await client.channels.fetch(channelId);
        if (!targetChannel) {
            return res.redirect('/dashboard?error=channel_not_found');
        }

        const embed = new EmbedBuilder()
            .setTitle("👑 New Minecraft Staff Application")
            .setDescription(`A new staff application has been submitted by <@${user.id}> for **RavixMC**. Review the details below carefully before taking action.`)
            .setColor(0x7c3aed)
            .setThumbnail(user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : user.defaultAvatarURL)
            .addFields(
                { name: "👤 Applicant Information", value: `• **Username:** ${user.username}\n• **Discord ID:** \`${user.id}\``, inline: false },
                
                { name: "📌 Basic & Personal Info", value: 
                    `**1. MC Username:** ${answers.q1 || '-'}\n` +
                    `**2. Discord Tag:** ${answers.q2 || '-'}\n` +
                    `**3. Age:** ${answers.q3 || '-'}\n` +
                    `**4. Country:** ${answers.q4 || '-'}\n` +
                    `**5. Time Zone:** ${answers.q5 || '-'}\n` +
                    `**6. Account Type:** ${answers.q6 || '-'}\n` +
                    `**7. Microphone:** ${answers.q7 || '-'}\n` +
                    `**8. Daily Playtime:** ${answers.q8 || '-'}`, 
                    inline: false 
                },

                { name: "⚙️ Experience & Suitability", value: 
                    `**9. Previous Experience:**\n\`\`\`${answers.q9 || '-'}\`\`\`\n` +
                    `**10. Why do you want to join our staff?**\n\`\`\`${answers.q10 || '-'}\`\`\`\n` +
                    `**11. Why should we choose you over others?**\n\`\`\`${answers.q11 || '-'}\`\`\`\n` +
                    `**12. What does being a Staff Member mean to you?**\n\`\`\`${answers.q12 || '-'}\`\`\``, 
                    inline: false 
                },

                { name: "🛡️ Scenario & Moderation Handling", value: 
                    `**13. How do you handle argument/conflict between players?**\n\`\`\`${answers.q13 || '-'}\`\`\`\n` +
                    `**14. How do you handle suspected hackers/cheaters?**\n\`\`\`${answers.q14 || '-'}\`\`\`\n` +
                    `**15. What would you do if you see staff abuse?**\n\`\`\`${answers.q15 || '-'}\`\`\``, 
                    inline: false 
                },

                { name: "🌐 Background & Extra Details", value: 
                    `**16. Previous Bans/Mutes:** ${answers.q16 || '-'}\n` +
                    `**17. Spoken Languages:** ${answers.q17 || '-'}\n` +
                    `**18. Additional Information:**\n\`\`\`${answers.q18 || 'N/A'}\`\`\``, 
                    inline: false 
                }
            )
            .setFooter({ text: "RavixMC Application Portal • Staff Review System", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`accept_${userId}`)
                    .setLabel('Accept Application')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${userId}`)
                    .setLabel('Reject Application')
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Danger)
            );

        await targetChannel.send({ embeds: [embed], components: [row] });

        db[userId] = {
            status: 'pending',
            date: new Date().toLocaleDateString('en-US'),
            answers: answers
        };
        saveDB(db);

        res.redirect('/dashboard');
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.redirect('/dashboard?error=true');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// التعديل الخاص بـ Vercel هنا:
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

// تصدير التطبيق ليعمل بنجاح على Vercel Serverless
module.exports = app;
