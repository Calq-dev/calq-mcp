import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CALQ_MCP_URL = process.env.CALQ_MCP_URL || 'https://mcp.calq.nl/mcp';
const ALLOWED_CHANNEL_IDS = process.env.ALLOWED_CHANNEL_IDS?.split(',').map(id => id.trim()) || [];
const REQUIRE_MENTION = process.env.REQUIRE_MENTION === 'true';

if (!DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN environment variable');
    process.exit(1);
}

if (!ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY environment variable');
    process.exit(1);
}

// Store user tokens (Discord user ID -> Calq access token)
// In production, this should be persisted to a database
const userTokens = new Map();

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // Required for DMs
});

// System prompt for the agent
const SYSTEM_PROMPT = `You are Calq, a helpful assistant for time tracking and task management. You have access to tools that let you:

- Start and stop timers for tracking work
- Log time entries to projects
- Manage tasks (create, list, complete)
- Sync with YouTrack issues
- Search memories and past entries

When users ask you to do something, use the appropriate tools. Be concise in your responses since this is Discord.

If a user hasn't connected their Calq account yet, let them know they need to authenticate first using the !connect command.`;

// Process a message with the Claude agent
async function processWithAgent(message, userPrompt, accessToken) {
    // Show typing indicator
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
    }, 5000);

    try {
        let finalResponse = '';
        let toolsUsed = [];

        const mcpConfig = accessToken ? {
            "calq": {
                type: "sse",
                url: CALQ_MCP_URL,
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                }
            }
        } : {};

        for await (const msg of query({
            prompt: userPrompt,
            system: SYSTEM_PROMPT,
            options: {
                apiKey: ANTHROPIC_API_KEY,
                model: "claude-sonnet-4-5-20250929",
                maxTurns: 10,
                mcpServers: mcpConfig,
                permissionMode: "bypassPermissions", // Auto-approve tool calls
            }
        })) {
            // Handle different message types
            if (msg.type === "assistant") {
                const textContent = msg.content?.find(c => c.type === "text");
                if (textContent) {
                    finalResponse = textContent.text;
                }

                // Track tool usage
                const toolUses = msg.content?.filter(c => c.type === "tool_use") || [];
                for (const tool of toolUses) {
                    toolsUsed.push(tool.name);
                }
            }

            if (msg.type === "result") {
                if (msg.subtype === "success" && finalResponse) {
                    clearInterval(typingInterval);

                    // Split long responses for Discord's 2000 char limit
                    if (finalResponse.length > 1900) {
                        const chunks = splitMessage(finalResponse, 1900);
                        for (const chunk of chunks) {
                            await message.reply(chunk);
                        }
                    } else {
                        await message.reply(finalResponse);
                    }
                    return;
                }

                if (msg.subtype === "error_during_execution") {
                    clearInterval(typingInterval);
                    await message.reply("Sorry, I encountered an error while processing your request.");
                    return;
                }
            }

            if (msg.type === "system" && msg.subtype === "init") {
                // Check MCP connection status
                const calqServer = msg.mcp_servers?.find(s => s.name === "calq");
                if (calqServer && calqServer.status !== "connected") {
                    console.error("Failed to connect to Calq MCP:", calqServer.status);
                }
            }
        }

        clearInterval(typingInterval);

        if (!finalResponse) {
            await message.reply("I processed your request but have nothing to report.");
        }
    } catch (error) {
        clearInterval(typingInterval);
        console.error("Agent error:", error);

        if (error.message?.includes("401") || error.message?.includes("unauthorized")) {
            await message.reply("Your Calq session has expired. Please use `!connect` to reconnect.");
            userTokens.delete(message.author.id);
        } else {
            await message.reply(`Something went wrong: ${error.message}`);
        }
    }
}

// Split long messages for Discord
function splitMessage(text, maxLength) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to split at a newline
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength / 2) {
            // Fall back to splitting at space
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex === -1) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).trim();
    }

    return chunks;
}

// Handle incoming messages
client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check channel restrictions
    if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channel.id)) {
        return;
    }

    const isMentioned = message.mentions.has(client.user);
    const isDM = !message.guild;

    // Check if we should respond
    if (REQUIRE_MENTION && !isMentioned && !isDM) {
        return;
    }

    // Remove bot mention from message content
    let content = message.content;
    if (isMentioned) {
        content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    }

    // Skip empty messages
    if (!content) return;

    // Handle special commands
    if (content.toLowerCase() === '!connect' || content.toLowerCase() === 'connect') {
        await message.reply(
            `To connect your Calq account, please:\n` +
            `1. Go to <${CALQ_MCP_URL.replace('/mcp', '')}> and authenticate\n` +
            `2. Once you have your access token, DM me: \`!token YOUR_TOKEN_HERE\`\n\n` +
            `Your token will be stored securely for this session.`
        );
        return;
    }

    if (content.toLowerCase().startsWith('!token ')) {
        const token = content.slice(7).trim();
        if (token) {
            userTokens.set(message.author.id, token);
            // Delete the message containing the token for security (if we have permission)
            try {
                await message.delete();
            } catch (e) {
                // Can't delete in DMs or without permission
            }
            await message.author.send("Your Calq account has been connected! You can now use me in the server.");
        } else {
            await message.reply("Please provide your token: `!token YOUR_TOKEN_HERE`");
        }
        return;
    }

    if (content.toLowerCase() === '!disconnect') {
        userTokens.delete(message.author.id);
        await message.reply("Your Calq account has been disconnected.");
        return;
    }

    if (content.toLowerCase() === '!help') {
        await message.reply(
            `**Calq Bot Commands**\n\n` +
            `• \`!connect\` - Get instructions to connect your Calq account\n` +
            `• \`!disconnect\` - Disconnect your Calq account\n` +
            `• \`!help\` - Show this help message\n\n` +
            `**Examples**\n` +
            `• "Start a timer for project calq"\n` +
            `• "What tasks do I have?"\n` +
            `• "Log 2 hours to calq for implementing Discord bot"\n` +
            `• "Show my issues from YouTrack"\n` +
            `• "Complete task CALQ-123"`
        );
        return;
    }

    // Get user's access token
    const accessToken = userTokens.get(message.author.id);

    if (!accessToken) {
        await message.reply(
            "You haven't connected your Calq account yet. Use `!connect` to get started."
        );
        return;
    }

    // Process with the agent
    await processWithAgent(message, content, accessToken);
});

// Bot ready
client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Connected to ${client.guilds.cache.size} servers`);
    console.log(`Calq MCP URL: ${CALQ_MCP_URL}`);

    if (REQUIRE_MENTION) {
        console.log('Bot requires @mention to respond');
    }
    if (ALLOWED_CHANNEL_IDS.length > 0) {
        console.log(`Restricted to channels: ${ALLOWED_CHANNEL_IDS.join(', ')}`);
    }
});

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Start the bot
client.login(DISCORD_TOKEN);
