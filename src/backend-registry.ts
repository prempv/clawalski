import type {
	BackendCronPool,
	BackendId,
	BackendPool,
	BackendRegistry,
} from "./backend.js";

export class DefaultBackendRegistry implements BackendRegistry {
	constructor(
		public readonly defaultId: BackendId,
		private readonly pools: ReadonlyMap<BackendId, BackendPool>,
		private readonly cronPools: ReadonlyMap<BackendId, BackendCronPool>,
	) {}

	pool(id: BackendId): BackendPool {
		const p = this.pools.get(id);
		if (!p) throw new Error(`No pool registered for backend: ${id}`);
		return p;
	}

	cronPool(id: BackendId): BackendCronPool {
		const p = this.cronPools.get(id);
		if (!p) throw new Error(`No cron pool registered for backend: ${id}`);
		return p;
	}

	closeAll(): void {
		for (const p of this.pools.values()) p.closeAll();
		for (const p of this.cronPools.values()) p.closeAll();
	}
}

/**
 * Per-conversation map of "pending backends" — set when a user issues
 * `/new <backend>` but hasn't yet sent a real message that opens the
 * session. Cleared once the first message is dispatched.
 */
export class PendingBackendStore {
	private map = new Map<string, BackendId>();

	get(conversationId: string): BackendId | null {
		return this.map.get(conversationId) ?? null;
	}

	set(conversationId: string, backend: BackendId): void {
		this.map.set(conversationId, backend);
	}

	clear(conversationId: string): void {
		this.map.delete(conversationId);
	}
}
