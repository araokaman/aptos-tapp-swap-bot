import * as dotenv from 'dotenv';
dotenv.config();

// 環境変数から通知設定を読み込む
const NOTIFICATION_SERVICE_ID = parseInt(process.env.NOTIFICATION_SERVICE || '0', 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;

/**
 * 指定されたサービスを通じてメッセージを送信します。
 * @param message 送信するテキストメッセージ
 */
export async function sendNotification(message: string): Promise<void> {
    if (NOTIFICATION_SERVICE_ID === 0) {
        console.warn("通知サービスIDが設定されていません (NOTIFICATION_SERVICE=0)。スキップします。");
        return;
    }

    try {
        switch (NOTIFICATION_SERVICE_ID) {
            case 1: // Discord
                await sendDiscordNotification(message);
                break;
            case 2: // Telegram
                await sendTelegramNotification(message);
                break;
            case 3: // LINE
                await sendLineNotification(message);
                break;
            default:
                console.warn(`未対応の通知サービスID: ${NOTIFICATION_SERVICE_ID}`);
        }
    } catch (error) {
        console.error("通知の送信中にエラーが発生しました:", error);
    }
}

/**
 * Discord Webhookを使用して通知を送信する内部関数。
 */
async function sendDiscordNotification(message: string): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) {
        throw new Error("Discord Webhook URLが設定されていません。");
    }

    const payload = {
        content: `[自動スワップ通知] ${message}`,
        username: "Aptos スワップBot",
    };

    await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    console.log("Discordに通知を送信しました。");
}

/**
 * Telegram Botを使用して通知を送信する内部関数 (実装が必要です)。
 */
async function sendTelegramNotification(message: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        throw new Error("Telegramの設定情報が不足しています。");
    }
    
    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const params = new URLSearchParams({
        chat_id: TELEGRAM_CHAT_ID,
        text: `[自動スワップ通知] ${message}`,
        parse_mode: 'Markdown',
    });

    await fetch(`${apiUrl}?${params.toString()}`, { method: 'GET' });
    
    console.log("Telegramに通知を送信しました。");
}

/**
 * LINE Notifyを使用して通知を送信する内部関数 (実装が必要です)。
 */
async function sendLineNotification(message: string): Promise<void> {
    if (!LINE_NOTIFY_TOKEN) {
        throw new Error("LINE Notifyトークンが設定されていません。");
    }
    
    const form = new URLSearchParams();
    form.append('message', `[自動スワップ通知] ${message}`);

    await fetch('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${LINE_NOTIFY_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });

    console.log("LINEに通知を送信しました。");
}
