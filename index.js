
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder
} = require("discord.js");

const Groq = require("groq-sdk");

// ==================================================
// CONFIGURACIÓN GENERAL
// ==================================================

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const SERVERS_FILE = path.join(DATA, "servers.json");

const OWNER_ID = process.env.OWNER_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

const BASE_URL = process.env.BASE_URL;
const CALLBACK_URL = process.env.CALLBACK_URL;

const config = require("./config.json");

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error("Configura un SESSION_SECRET seguro de al menos 32 caracteres.");
}

if (!BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !GROQ_KEY()) {
    console.warn("Faltan algunas credenciales. Revisa el archivo .env.");
}

function GROQ_KEY() {
    return process.env.GROQ_API_KEY;
}

// ==================================================
// ALMACENAMIENTO JSON
// ==================================================

if (!fs.existsSync(DATA)) {
    fs.mkdirSync(DATA, { recursive: true });
}

if (!fs.existsSync(SERVERS_FILE)) {
    fs.writeFileSync(
        SERVERS_FILE,
        JSON.stringify({
            servers: {},
            updatedAt: null
        }, null, 2)
    );
}

function readData() {
    try {
        const content = fs.readFileSync(SERVERS_FILE, "utf8");
        const data = JSON.parse(content);

        if (!data.servers) data.servers = {};

        return data;
    } catch (error) {
        console.error("Error leyendo servers.json:", error.message);

        return {
            servers: {},
            updatedAt: null
        };
    }
}

function saveData(data) {
    data.updatedAt = new Date().toISOString();

    const temporaryFile = SERVERS_FILE + ".tmp";

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(data, null, 2)
    );

    fs.renameSync(temporaryFile, SERVERS_FILE);
}

function getServerConfig(serverId) {
    const data = readData();

    if (!data.servers[serverId]) {
        data.servers[serverId] = {
            language: "es-CO",
            prefix: ",",
            aiEnabled: true,
            createdAt: new Date().toISOString(),
            usage: {
                messages: 0,
                images: 0,
                resetAt: Date.now() + 86400000
            },
            settings: {
                antiInsults: true,
                antiNsfw: true,
                antiSpam: true
            }
        };

        saveData(data);
    }

    return data.servers[serverId];
}

function updateServer(serverId, callback) {
    const data = readData();

    if (!data.servers[serverId]) {
        data.servers[serverId] = getServerConfig(serverId);
    }

    callback(data.servers[serverId]);

    saveData(data);
}

// ==================================================
// DISCORD CLIENT
// ==================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ]
});

// ==================================================
// GROQ IA
// ==================================================

const groq = GROQ_KEY()
    ? new Groq({
        apiKey: GROQ_KEY()
    })
    : null;

const SYSTEM_PROMPT = `
Eres MILO IA, un asistente inteligente para Discord y la web.

Tu idioma principal es español colombiano.
Responde de manera clara, natural, útil y respetuosa.
Adapta el tono a la conversación.
No inventes acciones que no hayas realizado.
No afirmes que modificaste un servidor si no se ejecutó
una acción real mediante las herramientas autorizadas.
`;

async function askMilo(message, options = {}) {
    if (!groq) {
        throw new Error("El servicio de IA no está configurado.");
    }

    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL || config.ai.model,
        messages: [
            {
                role: "system",
                content: SYSTEM_PROMPT
            },
            {
                role: "user",
                content: message
            }
        ],
        temperature: 0.7,
        max_tokens: 1500
    });

    return completion.choices?.[0]?.message?.content ||
        "No pude generar una respuesta.";
}

// ==================================================
// CONTROL DE USO
// ==================================================

function canUseMessage(serverId) {
    const data = readData();
    const server = data.servers[serverId];

    if (!server) return true;

    const now = Date.now();

    if (now >= server.usage.resetAt) {
        updateServer(serverId, settings => {
            settings.usage.messages = 0;
            settings.usage.images = 0;
            settings.usage.resetAt = now + 86400000;
        });

        return true;
    }

    return true;
}

function registerMessageUsage(serverId) {
    updateServer(serverId, server => {
        server.usage.messages++;
    });
}

// ==================================================
// COMANDOS SLASH
// ==================================================

const slashCommands = [
    new SlashCommandBuilder()
        .setName("ayuda")
        .setDescription("Muestra la ayuda de MILO IA"),

    new SlashCommandBuilder()
        .setName("server")
        .setDescription("Muestra información del servidor"),

    new SlashCommandBuilder()
        .setName("ia")
        .setDescription("Habla con MILO IA")
        .addStringOption(option =>
            option
                .setName("mensaje")
                .setDescription("Tu mensaje para MILO")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("configuracion")
        .setDescription("Consulta la configuración de MILO IA")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild
        )
];

async function registerCommands() {
    if (!BOT_TOKEN || !CLIENT_ID) return;

    const rest = new REST({
        version: "10"
    }).setToken(BOT_TOKEN);

    await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        {
            body: slashCommands.map(command =>
                command.toJSON()
            )
        }
    );

    console.log("Comandos slash registrados.");
}

// ==================================================
// AYUDA DISCORD
// ==================================================

function helpEmbed() {
    return new EmbedBuilder()
        .setColor(0x9333EA)
        .setTitle("🤖 MILO IA | Centro de ayuda")
        .setDescription(
            "Tu asistente inteligente para Discord."
        )
        .addFields(
            {
                name: "Comandos",
                value:
                    "`/ayuda` — Mostrar ayuda\n" +
                    "`/server` — Información del servidor\n" +
                    "`/ia` — Hablar con MILO IA\n" +
                    "`/configuracion` — Ver configuración"
            },
            {
                name: "Chat",
                value:
                    "Menciona a MILO IA o utiliza el prefijo `,`."
            }
        )
        .setFooter({
            text: "MILO IA • Tu asistente inteligente"
        });
}

// ==================================================
// EVENTOS DISCORD
// ==================================================

client.once("ready", async () => {
    console.log(`Discord conectado: ${client.user.tag}`);

    try {
        await registerCommands();
    } catch (error) {
        console.error(
            "Error registrando comandos:",
            error.message
        );
    }

    client.user.setPresence({
        status: "online",
        activities: [
            {
                name: "Protegiendo servidores",
                type: 0
            }
        ]
    });
});

// ==================================================
// COMANDOS SLASH Y RESPUESTAS
// ==================================================

client.on("interactionCreate", async interaction => {
    try {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "ayuda") {
            return interaction.reply({
                embeds: [helpEmbed()],
                ephemeral: true
            });
        }

        if (interaction.commandName === "server") {
            const guild = interaction.guild;

            if (!guild) {
                return interaction.reply({
                    content: "Este comando solo funciona en servidores.",
                    ephemeral: true
                });
            }

            const embed = new EmbedBuilder()
                .setColor(0x9333EA)
                .setTitle(`🌐 ${guild.name}`)
                .setThumbnail(guild.iconURL())
                .addFields(
                    {
                        name: "ID",
                        value: guild.id,
                        inline: true
                    },
                    {
                        name: "Miembros",
                        value: String(guild.memberCount),
                        inline: true
                    },
                    {
                        name: "Canales",
                        value: String(guild.channels.cache.size),
                        inline: true
                    },
                    {
                        name: "Propietario",
                        value: `<@${guild.ownerId}>`,
                        inline: true
                    }
                );

            return interaction.reply({
                embeds: [embed]
            });
        }

        if (interaction.commandName === "configuracion") {
            if (!interaction.memberPermissions?.has(
                PermissionFlagsBits.ManageGuild
            )) {
                return interaction.reply({
                    content: "No tienes permisos para consultar esta configuración.",
                    ephemeral: true
                });
            }

            const settings = getServerConfig(interaction.guildId);

            return interaction.reply({
                content:
                    `**Configuración de MILO IA**\n` +
                    `Idioma: ${settings.language}\n` +
                    `Prefijo: ${settings.prefix}\n` +
                    `IA: ${settings.aiEnabled ? "Activada" : "Desactivada"}`,
                ephemeral: true
            });
        }

        if (interaction.commandName === "ia") {
            const message = interaction.options.getString("mensaje");

            await interaction.deferReply();

            const response = await askMilo(message);

            if (interaction.guildId) {
                registerMessageUsage(interaction.guildId);
            }

            return interaction.editReply({
                content: response.slice(0, 1900)
            });
        }

    } catch (error) {
        console.error("Error en interacción:", error);

        const response = {
            content: "Ocurrió un error al procesar tu solicitud.",
            ephemeral: true
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// ==================================================
// CHAT POR MENCIÓN Y PREFIJO
// ==================================================

const recentMessages = new Map();

client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    const server = getServerConfig(message.guild.id);

    const mentioned = message.mentions.has(client.user);

    const prefix = server.prefix || ",";

    const prefixUsed = message.content.startsWith(prefix);

    if (!mentioned && !prefixUsed) return;

    let content = message.content;

    if (mentioned) {
        content = content
            .replace(/<@!?\\d+>/g, "")
            .trim();
    } else {
        content = content.slice(prefix.length).trim();
    }

    if (!content) {
        return message.reply(
            "¡Hola! Soy MILO IA. ¿Qué necesitas?"
        );
    }

    if (content.toLowerCase() === "ayuda") {
        return message.reply({
            embeds: [helpEmbed()]
        });
    }

    if (!server.aiEnabled) {
        return message.reply(
            "La inteligencia artificial está desactivada en este servidor."
        );
    }

    if (!canUseMessage(message.guild.id)) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const lastMessage = recentMessages.get(key) || 0;

    if (now - lastMessage < 2500) {
        return message.reply(
            "Espera un momento antes de enviar otro mensaje."
        );
    }

    recentMessages.set(key, now);

    try {
        await message.channel.sendTyping();

        const response = await askMilo(content);

        registerMessageUsage(message.guild.id);

        await message.reply({
            content: response.slice(0, 1900),
            allowedMentions: {
                repliedUser: false
            }
        });

    } catch (error) {
        console.error("Error respondiendo:", error.message);

        await message.reply(
            "No pude responder en este momento. Inténtalo más tarde."
        );
    }
});

// ==================================================
// EXPRESS Y SEGURIDAD WEB
// ==================================================

app.disable("x-powered-by");

app.use(express.json({
    limit: "100kb"
}));

app.use(session({
    name: "milo.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 60 * 1000
    }
}));

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
});

app.use(express.static(PUBLIC));

// ==================================================
// AUTENTICACIÓN DISCORD OAUTH2
// ==================================================

const oauthStates = new Map();

app.get("/auth/discord", (req, res) => {
    if (!CLIENT_ID || !CALLBACK_URL) {
        return res.status(503).send(
            "La autenticación de Discord no está configurada."
        );
    }

    const state = crypto.randomBytes(32).toString("hex");

    oauthStates.set(state, Date.now());

    req.session.oauthState = state;

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK_URL,
        response_type: "code",
        scope: "identify guilds",
        state
    });

    res.redirect(
        `https://discord.com/oauth2/authorize?${params.toString()}`
    );
});

app.get("/auth/discord/callback", async (req, res) => {
    try {
        const { code, state } = req.query;

        if (
            !code ||
            !state ||
            !req.session.oauthState ||
            state !== req.session.oauthState ||
            !oauthStates.has(state)
        ) {
            return res.status(400).send(
                "Autenticación inválida."
            );
        }

        const createdAt = oauthStates.get(state);

        oauthStates.delete(state);
        delete req.session.oauthState;

        if (Date.now() - createdAt > 5 * 60 * 1000) {
            return res.status(400).send(
                "La sesión de autenticación expiró."
            );
        }

        const tokenResponse = await fetch(
            "https://discord.com/api/v10/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: CALLBACK_URL
                })
            }
        );

        const tokens = await tokenResponse.json();

        if (!tokenResponse.ok || !tokens.access_token) {
            return res.status(401).send(
                "No se pudo verificar tu cuenta de Discord."
            );
        }

        const userResponse = await fetch(
            "https://discord.com/api/v10/users/@me",
            {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`
                }
            }
        );

        const user = await userResponse.json();

        if (!userResponse.ok || !user.id) {
            return res.status(401).send(
                "No se pudo obtener tu cuenta."
            );
        }

        const guildResponse = await fetch(
            "https://discord.com/api/v10/users/@me/guilds",
            {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`
                }
            }
        );

        const guilds = guildResponse.ok
            ? await guildResponse.json()
            : [];

        await new Promise((resolve, reject) => {
            req.session.regenerate(error => {
                if (error) return reject(error);
                resolve();
            });
        });

        req.session.user = {
            id: user.id,
            username: user.username,
            globalName: user.global_name || user.username,
            avatar: user.avatar,
            guilds: guilds
                .filter(guild => {
                    const permissions = BigInt(guild.permissions || "0");

                    return (
                        (permissions & 0x8n) === 0x8n ||
                        (permissions & 0x20n) === 0x20n ||
                        guild.owner
                    );
                })
                .map(guild => ({
                    id: guild.id,
                    name: guild.name,
                    icon: guild.icon,
                    owner: guild.owner
                }))
        };

        res.redirect("/");

    } catch (error) {
        console.error("OAuth error:", error.message);

        res.status(500).send(
            "Error durante el inicio de sesión."
        );
    }
});

// ==================================================
// SESIÓN Y CUENTA
// ==================================================

app.get("/api/user", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({
            error: "Debes iniciar sesión con Discord."
        });
    }

    res.json(req.session.user);
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("milo.sid");

        res.json({
            success: true
        });
    });
});


// ==================================================
// SERVIDORES DEL USUARIO
// ==================================================

app.get("/api/servers", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({
            error: "No autorizado."
        });
    }

    const data = readData();

    const servers = req.session.user.guilds.map(guild => ({
        ...guild,
        botPresent: client.guilds.cache.has(guild.id),
        settings: data.servers[guild.id] || null
    }));

    res.json({ servers });
});

// ==================================================
// SELECCIÓN Y PERMISOS
// ==================================================

function getAuthorizedGuild(req, guildId) {
    if (!req.session.user) return null;

    return req.session.user.guilds.find(
        guild => guild.id === guildId
    ) || null;
}

async function verifyGuildPermissions(req, guildId) {
    const authorizedGuild = getAuthorizedGuild(req, guildId);

    if (!authorizedGuild) return false;

    const guild = client.guilds.cache.get(guildId);

    if (!guild) return false;

    try {
        const member = await guild.members.fetch(req.session.user.id);

        return (
            member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.permissions.has(PermissionFlagsBits.ManageGuild) ||
            guild.ownerId === req.session.user.id
        );
    } catch {
        return false;
    }
}

app.get("/api/servers/:id", async (req, res) => {
    const guildId = req.params.id;

    const authorized = await verifyGuildPermissions(
        req,
        guildId
    );

    if (!authorized) {
        return res.status(403).json({
            error: "No tienes permisos para administrar este servidor."
        });
    }

    res.json({
        guild: client.guilds.cache.get(guildId).name,
        settings: getServerConfig(guildId)
    });
});

// ==================================================
// CONFIGURACIÓN POR SERVIDOR
// ==================================================

app.patch("/api/servers/:id/settings", async (req, res) => {
    const guildId = req.params.id;

    if (!(await verifyGuildPermissions(req, guildId))) {
        return res.status(403).json({
            error: "Permisos insuficientes."
        });
    }

    const allowed = [
        "language",
        "prefix",
        "aiEnabled"
    ];

    const changes = req.body;

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        return res.status(400).json({
            error: "Configuración inválida."
        });
    }

    for (const key of Object.keys(changes)) {
        if (!allowed.includes(key)) {
            return res.status(400).json({
                error: `No puedes modificar ${key}.`
            });
        }
    }

    if (
        changes.prefix !== undefined &&
        (
            typeof changes.prefix !== "string" ||
            changes.prefix.length > 5
        )
    ) {
        return res.status(400).json({
            error: "Prefijo inválido."
        });
    }

    if (
        changes.language !== undefined &&
        !["es-CO", "es-ES", "en-US"].includes(changes.language)
    ) {
        return res.status(400).json({
            error: "Idioma no disponible."
        });
    }

    if (
        changes.aiEnabled !== undefined &&
        typeof changes.aiEnabled !== "boolean"
    ) {
        return res.status(400).json({
            error: "Valor inválido para la IA."
        });
    }

    updateServer(guildId, settings => {
        Object.assign(settings, changes);
    });

    res.json({
        success: true,
        settings: getServerConfig(guildId)
    });
});

// ==================================================
// INFORMACIÓN DE CANALES
// ==================================================

app.get("/api/servers/:id/channels", async (req, res) => {
    const guildId = req.params.id;

    if (!(await verifyGuildPermissions(req, guildId))) {
        return res.status(403).json({
            error: "No autorizado."
        });
    }

    const guild = client.guilds.cache.get(guildId);

    const channels = guild.channels.cache
        .filter(channel =>
            [
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildCategory
            ].includes(channel.type)
        )
        .map(channel => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId
        }));

    res.json({ channels });
});

// ==================================================
// INFORMACIÓN DEL SERVIDOR
// ==================================================

app.get("/api/servers/:id/info", async (req, res) => {
    const guildId = req.params.id;

    if (!(await verifyGuildPermissions(req, guildId))) {
        return res.status(403).json({
            error: "No autorizado."
        });
    }

    const guild = client.guilds.cache.get(guildId);

    res.json({
        id: guild.id,
        name: guild.name,
        members: guild.memberCount,
        channels: guild.channels.cache.size,
        roles: guild.roles.cache.size,
        owner: guild.ownerId,
        icon: guild.iconURL()
    });
});

// ==================================================
// CHAT WEB
// ==================================================

app.post("/api/ai/chat", async (req, res) => {
    try {
        if (!req.session.user) {
            return res.status(401).json({
                error: "Inicia sesión con Discord."
            });
        }

        const message = req.body.message;

        if (
            typeof message !== "string" ||
            !message.trim() ||
            message.length > 4000
        ) {
            return res.status(400).json({
                error: "Mensaje inválido."
            });
        }

        const response = await askMilo(message);

        res.json({ response });

    } catch (error) {
        console.error("Error de chat:", error.message);

        res.status(503).json({
            error: "MILO IA no está disponible."
        });
    }
});

// ==================================================
// PANEL PRIVADO DEL PROPIETARIO
// ==================================================

app.get("/api/owner", async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({
            error: "Debes iniciar sesión."
        });
    }

    if (
        !OWNER_ID ||
        req.session.user.id !== OWNER_ID
    ) {
        return res.status(403).json({
            error: "Acceso denegado."
        });
    }

    res.json({
        authorized: true,
        owner: req.session.user.id,
        bot: client.isReady(),
        servers: client.guilds.cache.size,
        uptime: client.uptime,
        memory: process.memoryUsage().heapUsed
    });
});

// ==================================================
// ESTADO DEL SISTEMA
// ==================================================

app.get("/api/status", (req, res) => {
    res.json({
        name: "MILO IA",
        version: config.brand.version,
        website: true,
        discord: client.isReady(),
        ai: Boolean(groq),
        servers: client.guilds.cache.size,
        uptime: process.uptime()
    });
});

// ==================================================
// INVITACIÓN DEL BOT
// ==================================================

app.get("/invite", (req, res) => {
    const permissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
    ].reduce((total, permission) => total | permission, 0n);

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: "bot applications.commands",
        permissions: permissions.toString()
    });

    res.redirect(
        `https://discord.com/oauth2/authorize?${params.toString()}`
    );
});
 // ==================================================
 // PÁGINA PRINCIPAL
 // ==================================================

app.get("/", (req, res) => {
    res.sendFile(
        path.join(PUBLIC, "index.html")
    );
});

// ==================================================
// ERROR 404
// ==================================================

app.use((req, res) => {
    res.status(404).json({
        error: "Ruta no encontrada."
    });
});

// ==================================================
// MANEJO DE ERRORES
// ==================================================

app.use((error, req, res, next) => {
    console.error("Error web:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        error: "Error interno del servidor."
    });
});

// ==================================================
// CONFIRMACIÓN DE CONEXIÓN DISCORD
// ==================================================

client.once("ready", () => {
    console.log("================================");
    console.log("       MILO IA CONECTADO");
    console.log("================================");
    console.log("Bot:", client.user.tag);
    console.log("Servidores:", client.guilds.cache.size);
});

// ==================================================
// INICIO DEL SERVIDOR
// ==================================================

const server = app.listen(PORT, () => {
    console.log("================================");
    console.log("       MILO IA INICIADO");
    console.log("================================");
    console.log(`Puerto web: ${PORT}`);
    console.log(`Entorno: ${process.env.NODE_ENV || "development"}`);
});

// ==================================================
// CONEXIÓN DISCORD
// ==================================================

if (BOT_TOKEN) {
    client.login(BOT_TOKEN).catch(error => {
        console.error(
            "Error conectando Discord:",
            error.message
        );
    });
} else {
    console.error("BOT_TOKEN no configurado.");
}

// ==================================================
// CIERRE SEGURO
// ==================================================

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`Cerrando MILO IA: ${signal}`);

    client.destroy();

    server.close(() => {
        process.exit(0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

