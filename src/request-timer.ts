import { performance } from "node:perf_hooks";

export interface TimingSummary {
	[step: string]: number;
}

export class RequestTimer {
	private start = performance.now();
	private marks: [string, number][] = [];

	mark(name: string): void {
		this.marks.push([name, performance.now() - this.start]);
	}

	summary(): TimingSummary {
		const result: TimingSummary = {};
		for (const [name, elapsed] of this.marks) {
			result[name] = Math.round(elapsed);
		}
		result.total = Math.round(performance.now() - this.start);
		return result;
	}
}
