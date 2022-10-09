import Logger from './Logger.ts';

export class PrefixLogger implements Logger {
	public constructor(protected prefix: string, protected parent:Logger) {}

	// deno-lint-ignore no-explicit-any
	public log(thing:any, ...stuff:any[]) {
		this.parent.log(this.prefix, thing, ...stuff);	
	}
	// deno-lint-ignore no-explicit-any
	public warn(thing:any, ...stuff:any[]) {
		this.parent.warn(this.prefix, thing, ...stuff);
	}
	// deno-lint-ignore no-explicit-any
	public error(thing:any, ...stuff:any[]) {
		this.parent.error(this.prefix, thing, ...stuff);
	}
}

export default PrefixLogger;
