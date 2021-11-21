/**
 * Console-compatible logging interface.
 */
 interface Logger {
	 // deno-lint-ignore no-explicit-any
   error(message?: any, ...optionalParams: any[]): void;
	// deno-lint-ignore no-explicit-any
	warn(message?: any, ...optionalParams: any[]): void;
	// deno-lint-ignore no-explicit-any
   log(message?: any, ...optionalParams: any[]): void;
}

export const VERBOSITY_SILENT   = 0;
export const VERBOSITY_ERRORS   = 1;
export const VERBOSITY_WARNINGS = 2;
export const VERBOSITY_INFO     = 3;
export const VERBOSITY_DEBUG    = 4;

/*
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
*/

/** A logger that ignores everything */
export const NULL_LOGGER:Logger = {
	// deno-lint-ignore no-unused-vars no-explicit-any
	error(message?: any, ...optionalParams: any[]): void { },
	// deno-lint-ignore no-unused-vars no-explicit-any
	warn(message?: any, ...optionalParams: any[]): void { },
	// deno-lint-ignore no-unused-vars no-explicit-any
	log(message?: any, ...optionalParams: any[]): void { },
}

export default Logger;
