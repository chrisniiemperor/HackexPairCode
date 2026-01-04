import express from 'express';
import fs from 'fs';
import pino from 'pino';
import {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

/* ---------- utils ---------- */
function removeDir(dir) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('Remove dir error:', e);
    }
}

/* ---------- route ---------- */
router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ code: 'Phone number required' });

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);

    if (!phone.isValid()) {
        return res.status(400).json({
            code: 'Invalid phone number. Use full international format without +'
        });
    }

    num = phone.getNumber('e164').replace('+', '');
    const sessionDir = `./session_${num}`;

    // fresh session
    removeDir(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    let pairingRequested = false;

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'silent' })
            ),
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.android('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 90_000,
        defaultQueryTimeoutMs: 90_000,
        keepAliveIntervalMs: 30_000
    });

    /* ---------- events ---------- */
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // 🔑 REQUEST PAIRING CODE (CORRECT & ONLY ONCE)
        if (
            connection === 'connecting' &&
            !sock.authState.creds.registered &&
            !pairingRequested
        ) {
            pairingRequested = true;

            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join('-') || code;

                if (!res.headersSent) {
                    console.log('📲 Pairing code:', code);
                    res.json({ code });
                }
            } catch (err) {
                console.error('❌ Pairing error:', err);
                if (!res.headersSent) {
                    res.status(503).json({ code: 'Failed to request pairing code' });
                }
            }
        }

        // ✅ CONNECTED
        if (connection === 'open') {
            console.log('✅ WhatsApp connected');

            try {
                const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                const creds = fs.readFileSync(sessionDir + '/creds.json');

                await sock.sendMessage(userJid, {
                    document: creds,
                    mimetype: 'application/json',
                    fileName: 'creds.json'
                });

                await sock.sendMessage(userJid, {
                    text:
`⚠️ DO NOT SHARE THIS FILE

┌┤✑ Thanks for using Hackex Bot
│© 2026 CHRIS-TECH ✌︎㋡
└──────────────`
                });

                console.log('📄 Session sent successfully');
            } catch (e) {
                console.error('Send session error:', e);
            }
        }

        // ❌ CLOSED (NO AUTO-RESTART LOOP)
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ Connection closed:', code);
        }
    });
});

/* ---------- safety ---------- */
process.on('uncaughtException', err => {
    const msg = String(err);
    if (
        msg.includes('conflict') ||
        msg.includes('rate-overlimit') ||
        msg.includes('Connection Closed')
    ) return;
    console.error('Uncaught:', err);
});

export default router;
