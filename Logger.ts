/**
 * Console-compatible logging interface.
 */
export interface Logger {
   error(message?: unknown, ...optionalParams: unknown[]): void;
	warn(message?: unknown, ...optionalParams: unknown[]): void;
   log(message?: unknown, ...optionalParams: unknown[]): void;
}

export const VERBOSITY_SILENT   = 0;
export const VERBOSITY_ERRORS   = 50;
export const VERBOSITY_WARNINGS = 100;
export const VERBOSITY_INFO     = 200;
export const VERBOSITY_DEBUG    = 300;

export class LevelFilteringLogger implements Logger {
	constructor( protected backingLogger:Logger, protected verbosity:number ) { }
	
	// deno-lint-ignore no-explicit-any
   error(message?: any, ...etc: any[]): void {
		if( this.verbosity < VERBOSITY_ERRORS ) return;
		this.backingLogger.error( message, ...etc );
	}

	// deno-lint-ignore no-explicit-any
   warn(message?: any, ...etc: any[]): void {
		if( this.verbosity < VERBOSITY_WARNINGS ) return;
		this.backingLogger.warn( message, ...etc );
	}
	
	// deno-lint-ignore no-explicit-any
   log(message?: any, ...etc: any[]): void {
		if( this.verbosity < VERBOSITY_INFO ) return;
		this.backingLogger.log( message, ...etc );
	}
}

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

/** A logger that ignores everything */
export const NULL_LOGGER:Logger = {
	error(_message?: unknown, ..._optionalParams: unknown[]): void { },
	warn(_message?: unknown, ..._optionalParams: unknown[]): void { },
	log(_message?: unknown, ..._optionalParams: unknown[]): void { },
}

export default Logger;
