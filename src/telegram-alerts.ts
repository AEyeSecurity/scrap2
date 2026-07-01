import type { Logger } from 'pino';

export interface TelegramAlertConfig {
  botToken: string;
  chatId: string;
}

export interface TelegramAlertPayload {
  title: string;
  ownerKey: string;
  ownerLabel: string;
  status: string;
  phoneE164?: string | null;
  timestamp: string;
  detail?: string | null;
}

export interface TelegramAlertSender {
  send(payload: TelegramAlertPayload): Promise<void>;
}

export function buildTelegramAlertConfigFromEnv(env = process.env): TelegramAlertConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || env.SUPERBOT_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_ALERT_CHAT_ID?.trim() || env.SUPERBOT_TELEGRAM_ALERT_CHAT_ID?.trim();

  return botToken && chatId ? { botToken, chatId } : null;
}

function formatTelegramAlert(payload: TelegramAlertPayload): string {
  const lines = [
    `MasterCRM QR: ${payload.title}`,
    `Cajero: ${payload.ownerLabel}`,
    `Owner: ${payload.ownerKey}`,
    `Estado: ${payload.status}`,
    `Fecha: ${payload.timestamp}`
  ];

  if (payload.phoneE164) {
    lines.splice(3, 0, `Linea: ${payload.phoneE164}`);
  }
  if (payload.detail) {
    lines.push(`Detalle: ${payload.detail}`);
  }

  return lines.join('\n');
}

export class TelegramHttpAlertSender implements TelegramAlertSender {
  constructor(
    private readonly config: TelegramAlertConfig,
    private readonly logger: Logger
  ) {}

  async send(payload: TelegramAlertPayload): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text: formatTelegramAlert(payload),
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      this.logger.warn(
        {
          status: response.status,
          ownerKey: payload.ownerKey,
          alertStatus: payload.status
        },
        'Telegram QR alert failed'
      );
    }
  }
}

export class NoopTelegramAlertSender implements TelegramAlertSender {
  async send(): Promise<void> {
    // no-op when Telegram is not configured.
  }
}
