/** Minimal Telegram Bot API types for the gateway. */

export interface PhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

/** Content block for Claude CLI stream-json input. */
export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
	  };

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
	is_forum?: boolean;
}

export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	message_thread_id?: number;
	reply_to_message?: TelegramMessage;

	// Media types
	photo?: PhotoSize[];
	video?: unknown;
	document?: {
		file_id: string;
		file_unique_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
	audio?: unknown;
	voice?: unknown;
	sticker?: { emoji?: string };
	caption?: string;
	media_group_id?: string;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface TelegramApiResponse<T = unknown> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: {
		retry_after?: number;
		migrate_to_chat_id?: number;
	};
}

export interface SendMessageParams {
	chat_id: number;
	text: string;
	parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
	message_thread_id?: number;
	reply_parameters?: { message_id: number };
	reply_markup?: InlineKeyboardMarkup;
}

export interface EditMessageTextParams {
	chat_id: number;
	message_id: number;
	text: string;
	parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
	reply_markup?: InlineKeyboardMarkup;
}

export interface SendChatActionParams {
	chat_id: number;
	action: "typing";
	message_thread_id?: number;
}

export interface DeleteMessageParams {
	chat_id: number;
	message_id: number;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
	text: string;
	callback_data?: string;
	url?: string;
}
