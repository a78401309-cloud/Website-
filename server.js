require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

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

let isApplicationsOpen = true;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', async () => {
    console.log(`🤖 Discord Bot logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const [action, userId] = interaction.customId.split('_');
        const db = getDB();

        if (!db[userId]) {
            return interaction.reply({ content: '❌ Applicant data not found.', ephemeral: true });
        }

        if (action === 'accept') {
            db[userId].status = 'accepted';
            saveDB(db);
            await interaction.update({ content: '✅ Application Accepted!', embeds: [], components: [] });
        } else if (action === 'reject') {
            db[userId].status = 'rejected';
            saveDB(db);
            await interaction.update({ content: '❌ Application Rejected!', embeds: [], components: [] });
        }
    }
});

client.login(process.env.BOT_TOKEN);
