import type { Logger } from "./logger.js";
import type {
	DeleteMessageParams,
	EditMessageTextParams,
	SendChatActionParams,
	SendMessageParams,
	TelegramApiResponse,
	TelegramFile,
	TelegramMessage,
	TelegramUpdate,
	TelegramUser,
} from "./types.js";

const TELEGRAM_API = "https://api.telegram.org";

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const NETWORK_RETRY_COUNT = 2;
const NETWORK_RETRY_DELAY_MS = 1000;

export class TelegramRateLimitError extends Error {
	readonly method: string;
	readonly retryAfter: number;
	constructor(method: string, retryAfter: number, description?: string) {
		super(
			`Telegram API rate limit [${method}]: retry after ${retryAfter}s${
				description ? ` — ${description}` : ""
			}`,
		);
		this.name = "TelegramRateLimitError";
		this.method = method;
		this.retryAfter = retryAfter;
	}
}

export interface TelegramClientOptions {
	logger?: Logger;
}

export class TelegramClient {
	private readonly baseUrl: string;
	private readonly log?: Logger;

	constructor(
		private readonly token: string,
		opts: TelegramClientOptions = {},
	) {
		this.baseUrl = `${TELEGRAM_API}/bot${token}`;
		this.log = opts.logger;
	}

	async getMe(): Promise<TelegramUser> {
		return this.call<TelegramUser>("getMe");
	}

	async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
		const params: Record<string, string> = { timeout: String(timeout) };
		if (offset !== undefined) params.offset = String(offset);
		return this.call<TelegramUpdate[]>("getUpdates", params);
	}

	async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("sendMessage", { ...params });
	}

	async editMessageText(
		params: EditMessageTextParams,
	): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("editMessageText", { ...params });
	}

	async sendChatAction(params: SendChatActionParams): Promise<void> {
		await this.call("sendChatAction", { ...params });
	}

	async deleteMessage(params: DeleteMessageParams): Promise<void> {
		await this.call("deleteMessage", { ...params });
	}

	/**
	 * Set or clear emoji reactions on a message. Used to acknowledge queued
	 * messages without spamming the chat with text replies. Pass an empty
	 * `emojis` array to clear reactions. Bot API 7.0+.
	 */
	async setMessageReaction(params: {
		chat_id: number;
		message_id: number;
		emojis: string[];
	}): Promise<void> {
		await this.call("setMessageReaction", {
			chat_id: params.chat_id,
			message_id: params.message_id,
			reaction: params.emojis.map((emoji) => ({ type: "emoji", emoji })),
		});
	}

	async setWebhook(url: string, secret?: string): Promise<void> {
		const params: Record<string, string> = { url };
		if (secret) params.secret_token = secret;
		await this.call("setWebhook", params);
	}

	async deleteWebhook(): Promise<void> {
		await this.call("deleteWebhook");
	}

	async setMyCommands(
		commands: { command: string; description: string }[],
	): Promise<void> {
		await this.call("setMyCommands", { commands });
	}

	async getFile(fileId: string): Promise<TelegramFile> {
		return this.call<TelegramFile>("getFile", { file_id: fileId });
	}

	async downloadFileBuffer(filePath: string): Promise<Buffer> {
		const url = `${TELEGRAM_API}/file/bot${this.token}/${filePath}`;
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				`Telegram file download failed: ${res.status} ${res.statusText}`,
			);
		}
		return Buffer.from(await res.arrayBuffer());
	}

	private async call<T>(
		method: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		let rateLimitAttempt = 0;
		let networkAttempt = 0;

		while (true) {
			let res: Response;
			try {
				res = await fetch(`${this.baseUrl}/${method}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: body ? JSON.stringify(body) : undefined,
				});
			} catch (err) {
				if (networkAttempt >= NETWORK_RETRY_COUNT) throw err;
				const delay = NETWORK_RETRY_DELAY_MS * 2 ** networkAttempt;
				networkAttempt += 1;
				this.log?.warn(
					{ method, err, attempt: networkAttempt, delay },
					"telegram network error, retrying",
				);
				await sleep(delay);
				continue;
			}

			const json = (await res.json()) as TelegramApiResponse<T>;

			if (json.ok) return json.result as T;

			if (
				json.error_code === 429 &&
				rateLimitAttempt < MAX_RATE_LIMIT_RETRIES
			) {
				const requested = json.parameters?.retry_after ?? 1;
				const waitSec = Math.min(
					Math.max(requested, 1),
					MAX_RETRY_AFTER_SECONDS,
				);
				rateLimitAttempt += 1;
				this.log?.warn(
					{
						method,
						retryAfter: waitSec,
						attempt: rateLimitAttempt,
						description: json.description,
					},
					"telegram rate limited, sleeping before retry",
				);
				await sleep(waitSec * 1000 + 50);
				continue;
			}

			if (json.error_code === 429) {
				throw new TelegramRateLimitError(
					method,
					json.parameters?.retry_after ?? 0,
					json.description,
				);
			}

			throw new Error(
				`Telegram API error [${method}]: ${json.error_code} — ${json.description}`,
			);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
