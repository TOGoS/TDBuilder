import { mtimeR, touchDir, makeRemoved } from './FSUtil.ts';
import Logger, {LevelFilteringLogger, NULL_LOGGER, VERBOSITY_ERRORS, VERBOSITY_INFO, VERBOSITY_WARNINGS} from './Logger.ts';

export type BuildResult = { mtime: number };

export type BuildFunction = (ctx:BuildContext) => Promise<void>;

export type BuildFunctionTransformer = (cb:BuildFunction) => BuildFunction;

export interface MiniBuildContext {
	buildRuleTrace: string[];
}

export interface MiniBuilder {
	build( targetName:string, ctx:MiniBuildContext ) : Promise<BuildResult>;
}

export interface BuildContext extends MiniBuildContext {
	builder: MiniBuilder;
	logger: Logger;
	prereqNames: string[];
	targetName: string;
}

type TargetTypeName = "directory"|"file"|"phony"|"auto";

const NOOP_BUILD_FUNCTION_TRANSFORMER:BuildFunctionTransformer = (bf:BuildFunction) => bf;

export interface BuildRule {
	description?: string;
	/** a list of names of targets that must be built before this build rule can be invoked */
	prereqs?: Iterable<string>|AsyncIterable<string>;

	/** Function to invoke to build the target */
	invoke? : BuildFunction;
	/** An alternative to invoke: a system command to be run */
	cmd?: string[],

	/**
	 * A function that will wrap the logic around running the build rule
	 * (said logic includes transforming `cmd` to a BuildFunction,
	 * built-in checks and logging).
	 * 
	 * May be used e.g. to lock a mutex before a rule is invoked
	 * and release it afterwards.
	 * 
	 * Defaults to the identity function.
	 */
	buildFunctionTransformer?: BuildFunctionTransformer,

	// Metadata to allow Builder to automatically fix existence or mtime:

	/** Unless set to true, the target will be removed if the build rule fails */
	keepOnFailure?: boolean;
	/**
	 * What does the target name name?
	 * - "auto" (default assumption) :: the target may be a file, a directory, or nothing.
	 *   If a file or directory by the name does exist, its modification time will be used.
	 *   Builder won't verify existence after invoking the build rule.
	 * - "directory" :: it is expected that a directory matching the name of the target
	 *   will exist after the rule is invoked, and builder will automatically (by unspecified means)
	 *   update the modification timestamp of the directory after the rule is invoked.
	 *   If the target does not exist after invoking the build rule, or is not a directory
	 *   (or symlink to one), an error will be thrown.
	 * - "file" :: the target name names a file to be created or updated,
	 *   and if the file does not exist or is not a regular file (or symlink to one) after the rule is invoked,
	 *   an error will be thrown.
	 * - "phony" :: the target is assumed to not correspond with anything on the filesystem,
	 *   and will always be run.
	 */
	targetType?: TargetTypeName
	/**
	 * @deprecated - use targetType, instead
	 * isDirectory: true is a synonym for targetType: "directory"
	 * It does not make sense to specify both isDirectory and targetType.
	 */
	isDirectory?: boolean;
}

/** Remove duplicates from a list, keeping the first occurrence */
function deduplicate<T>(stuff:T[]) : T[] {
	const alreadyMentioned = new Set<T>();
	return stuff.filter( thing => {
		if( alreadyMentioned.has(thing) ) return false;
		alreadyMentioned.add(thing);
		return true;
	});
}

function prettyCmdArg(arg:string) : string {
	if( /^[A-Za-z0-9_\+\-\.]+$/.exec(arg) ) {
		return arg;
	} else {
		return `"${arg.replaceAll('\\','\\\\').replaceAll('"','\"')}"`;
	}
}

function prettyCmd(cmd:string[]) : string {
	return cmd.map(prettyCmdArg).join(' ');
}

function getRuleTargetType(rule:BuildRule, targetName:string, ctx:BuildContext) : TargetTypeName {
	if( rule.isDirectory !== undefined && rule.targetType !== undefined ) {
		throw new BuildError(`Rule for target '${targetName}' specifies both isDirectory and targetType`, ctx.buildRuleTrace);
	}
	if( rule.targetType !== undefined ) return rule.targetType;
	return "auto";
}

function rewriteCommand(cmd:string[], ctx:BuildContext) : string[] {
	const rewritten:string[] = [];
	for( const arg of cmd ) {
		let m : RegExpExecArray|null;
		if( (m = /^tdb:literal:(.*)$/.exec(arg)) !== null ) {
			rewritten.push(m[1]);
		} else if( (m = /^tdb:target$/.exec(arg)) !== null ) {
			rewritten.push(ctx.targetName);
		} else if( (m = /^tdb:prereq$/.exec(arg)) !== null ) {
			if( ctx.prereqNames.length < 1 ) {
				throw new BuildError(`Can't evaluate argument ${arg}: no prereqs for target '${ctx.targetName}'`, ctx.buildRuleTrace);
			}
			rewritten.push(ctx.prereqNames[0]);
		} else if( (m = /^tdb:prereqs$/.exec(arg)) !== null ) {
			for( const prereq of ctx.prereqNames ) {
				rewritten.push(prereq);
			}
		} else if( (m = /^tdb:.*$/.exec(arg)) !== null ) {
			throw new BuildError(`Unrecognized 'tdb:' argument in command: '${arg}'`, ctx.buildRuleTrace);
		} else {
			rewritten.push(arg);
		}
	}
	return rewritten;
}

function getRuleBuildFunction(rule:BuildRule, ctx:BuildContext) : BuildFunction|undefined {
	if( rule.cmd && rule.invoke ) {
		throw new BuildError(`Rule for target '${ctx.targetName}' indicates both invoke() and a cmd!`, ctx.buildRuleTrace);
	}
	if( rule.invoke ) return rule.invoke;
	const rawCmd = rule.cmd;
	if( rawCmd ) {
		const cmd = rewriteCommand(rawCmd, ctx);
		return async (ctx:BuildContext) => {
			ctx.logger.log(`Running \`${prettyCmd(cmd)}\`...`);
			let status : Deno.ProcessStatus;
			try {
				const proc = await Deno.run({cmd});
				status = await proc.status();
				proc.close();
			} catch( e ) {
				const message = e.message || ""+e;
				throw new BuildError(`Failed to run command: \`${prettyCmd(cmd)}\`: ${message}`, ctx.buildRuleTrace);
			}
			if( !status.success ) {
				throw new BuildError(`\`${prettyCmd(cmd)}\` exited with status ${status.code}`, ctx.buildRuleTrace);
			}
		}
	}
	return undefined;
}

function getRuleBuildFunctionTransformer(rule:BuildRule, _ctx:BuildContext) : BuildFunctionTransformer {
	if( rule.buildFunctionTransformer ) return rule.buildFunctionTransformer;
	return NOOP_BUILD_FUNCTION_TRANSFORMER;
}

type FailureFileAction = "delete"|"keep";

function getFailureFileAction(rule:BuildRule) : FailureFileAction {
	if( rule.keepOnFailure !== undefined ) return rule.keepOnFailure ? "keep" : "delete";

	// By default, blow away regular files, but leave everything else alone 'for safety'
	return rule.targetType == "file" ? "delete" : "keep";
}

/**
 * Builder constructor options.
 */
export interface BuilderOptions {
	/** BuildRules, keyed by target name */
	rules? : {[targetName:string]: BuildRule};
	/** The logger that the builder will use.  Defaults to `NULL_LOGGER` */
	logger? : Logger;
	/** List of targets that should always be built */
	globalPrerequisiteNames? : string[];
	/** Names of targets that should be assumed when none are specified on the command-line */
	defaultTargetNames? : string[];
	/** How to refer to the command-line script that is calling Builder?  For --help purposes. */
	buildScriptName? : string;
	///** Allowed concurrency modes; default is the first in the list, and the default list is ['parallel','serial'] */
	//allowedConcurrencyModes? : ConcurrencyMode[];
	/** Default concurrency mode, 'parallel' or 'serial'.  May be overridden to 'serial' by a command-line option. */
	concurrencyMode? : ConcurrencyMode;
}

type BuildOperationName = "build"|"describe-targets"|"list-targets"|"print-help";
type ConcurrencyMode = "parallel"|"serial";

export interface BuildParameters {
	buildOperation: BuildOperationName;
	targetNames: string[];
	targetsSpecifiedVia: string;
	verbosity: number;
	concurrencyMode? : ConcurrencyMode;
}

/**
 * Anything, but generally an exception object,
 * that has a build trace consisting of the names of build targets
 * that were being built which led to the error.
 */
interface HasBuildTrace {
	tdBuildTrace : string[];
}

function mightHaveBuildTrace(x:unknown) : x is {tdBuildTrace?: unknown} {
	return typeof(x) == 'object';
}

function hasBuildTrace(x:unknown) : x is HasBuildTrace {
	return mightHaveBuildTrace(x) && Array.isArray(x.tdBuildTrace) && x.tdBuildTrace.reduce(
		(p:boolean, v:unknown) => p && typeof(v) == 'string',
		true
	);
}

export class BuildError extends Error implements HasBuildTrace {
	constructor(message:string, public tdBuildTrace:string[]) {
		super(message);
	}
}

const RESOLVED_VOID_PROMISE = Promise.resolve();

/**
 * The thing that builds.
 * After constructing, call `build( targetName )` to build a specific target,
 * or `processCommandLine( args )` to run based on command-line arguments.
 */
export default class Builder implements MiniBuilder {
	/**
	 * List of things to always consider prereqs,
	 * such as the build script itself.
	 */
	protected globalPrereqs:string[];
	protected defaultTargetNames:string[];
	protected buildRules : {[targetName:string]: BuildRule};
	protected configuredLogger:Logger;
	protected buildScriptName:string;

	protected logger:Logger; // 'effective logger' - takes verbosity into account
	protected buildPromises:{[name:string]: Promise<BuildResult>} = {};
	protected allBuildPromisesSettled : Promise<unknown> = RESOLVED_VOID_PROMISE;
	protected concurrencyMode : ConcurrencyMode;
	protected isShuttingDown = false;
	
	public constructor(opts:BuilderOptions={}) {
		this.buildRules = opts.rules || {};
		this.logger = this.configuredLogger = opts.logger || NULL_LOGGER;
		this.globalPrereqs = opts.globalPrerequisiteNames || [];
		this.defaultTargetNames = opts.defaultTargetNames || [];
		this.buildScriptName = opts.buildScriptName || "(build script)";
		this.concurrencyMode = opts.concurrencyMode ?? "parallel";
	}
	
	/** Here so you can override it */
	protected fetchGeneratedTargets():Promise<{[name:string]:BuildRule}> {
		return Promise.resolve({});
	}
	
	protected allTargetsPromise:Promise<{[name:string]:BuildRule}>|undefined = undefined;
	protected async fetchAllBuildRules() : Promise<{[name:string]:BuildRule}> {
		if( this.allTargetsPromise ) return this.allTargetsPromise;
		
		const allTargets:{[name:string]:BuildRule} = {};
		for( const n in this.buildRules ) allTargets[n] = this.buildRules[n];
		const generatedTargets = await this.fetchGeneratedTargets();
		for( const n in generatedTargets ) allTargets[n] = generatedTargets[n];
		return allTargets;
	}
	
	protected fetchBuildRuleForTarget( targetName:string ):Promise<BuildRule> {
		return this.fetchAllBuildRules().then( (targets) => targets[targetName] );
	}

	protected verifyTarget( targetName:string, targetType:TargetTypeName, ctx:BuildContext ) : Promise<void> {
		switch(targetType) {
		case "file":
			this.logger.log("Verifying that "+targetName+" is a regular file...");
			return Deno.stat(targetName).then( stat => {
				if( !stat.isFile ) {
					return Promise.reject(new BuildError(`Target '${targetName}' should be a regular file, but is not`, ctx.buildRuleTrace));
				}
			}, (err:Error) => {
				if( err.name == "NotFound" ) {
					return Promise.reject(new BuildError(`Target '${targetName}' should be a regular file, but did not exist after building`, ctx.buildRuleTrace));
				}
				return Promise.reject(err);
			});
		case "directory":
			this.logger.log("Verifying that "+targetName+" is a directory...");
			return Deno.stat(targetName).then( stat => {
				if( !stat.isDirectory ) {
					return Promise.reject(new BuildError(`Target '${targetName}' should be a directory, but is not`, ctx.buildRuleTrace));
				}
			}, (err:Error) => {
				if( err.name == "NotFound" ) {
					return Promise.reject(new BuildError(`Target '${targetName}' should be a directory, but did not exist after building`, ctx.buildRuleTrace));
				}
				return Promise.reject(err);
			});
		default:
			this.logger.log(`${targetName}'s type = ${targetType}; doing no verification`);
			// No verification needed for phony or auto
			return Promise.resolve();
		}
	}

	protected postProcessTarget(targetName:string, targetType:string) : Promise<void> {
		switch(targetType) {
		case "directory":
			return touchDir(targetName);
		default:
			return Promise.resolve();
		}
	}
	
	protected async buildTarget( targetName:string, rule:BuildRule, parentBuildRuleTrace:string[] ):Promise<BuildResult> {
		const prereqNames:string[] = [];
		if( rule.prereqs ) {
			// Rule's explicit prereqs must be first in
			// case they want to refer to them from the build function
			for await(const prereqName of rule.prereqs ) {
				prereqNames.push(prereqName);
			}
		}
		for( const prereqName of this.globalPrereqs ) {
			prereqNames.push(prereqName);
		}
		const buildRuleTrace = parentBuildRuleTrace.concat( targetName )
		const ctx : BuildContext = {
			builder: this,
			logger: this.logger,
			prereqNames,
			targetName,
			buildRuleTrace
		};

		const targetType = getRuleTargetType(rule, targetName, ctx);
		let targetMtime = targetType == "phony" ? -Infinity : await mtimeR(targetName, -Infinity).catch( (e:Error) => {
			if( e.name == "NotFound" ) return -Infinity;
			return Promise.reject(e);
		});
		
		const latestPrereqMtime = (await this.buildAll(prereqNames, ctx)).mtime;
		
		if( targetMtime == -Infinity || latestPrereqMtime > targetMtime ) {
			const buildFunction = getRuleBuildFunction(rule, ctx);
			const buildWrapper = getRuleBuildFunctionTransformer(rule, ctx);
			const wrappedBuildFunction = buildWrapper(async (ctx:BuildContext) => {
				if( buildFunction ) {
					try {
						this.logger.log("Running build function for "+targetName+"...");
						await buildFunction(ctx);
						this.logger.log("Build function for "+targetName+" returned without error");
					} catch( err ) {
						//console.error(`Error while building ${targetName}:`, err);
						//console.error("Error trace: "+buildRuleTrace.join(' > '));
						const rejection = Promise.reject(err);
						switch( getFailureFileAction(rule) ) {
						case "delete":
							this.logger.error("Removing "+targetName);
							return makeRemoved(targetName, {recursive:true}).then(() => rejection);
						case "keep":
							this.logger.log("Keeping "+targetName+" despite failure");
						}
						return rejection;
					}
				} else {
					this.logger.log(targetName+" has no build rule; assuming up-to-date");
				}
				await this.verifyTarget(targetName, targetType, ctx);
				await this.postProcessTarget(targetName, targetType);
			});
			await wrappedBuildFunction(ctx);
			
			targetMtime = targetType == "phony" ? Infinity : await mtimeR(targetName, -Infinity);
		} else {
			this.logger.log(targetName+" is already up-to-date");
		}
		
		return {
			mtime: targetMtime
		};
	}

	public build( targetName:string, ctx:MiniBuildContext ) : Promise<BuildResult> {
		if( this.buildPromises[targetName] != undefined ) return this.buildPromises[targetName];
		
		const bp = this.buildPromises[targetName] = this.fetchBuildRuleForTarget(targetName).then( rule => {
			if( rule == null ) {
				return mtimeR(targetName, "error").then( mtime => {
					this.logger.log(targetName+" exists but has no build rule; assuming up-to-date");
					return {mtime};
				}, _err => {
					return Promise.reject(new BuildError(targetName+" does not exist and I don't know how to build it.", ctx.buildRuleTrace));
				});
			} else {
				return this.buildTarget(targetName, rule, ctx.buildRuleTrace);
			}
		});
		
		this.allBuildPromisesSettled = this.allBuildPromisesSettled.then(() => bp.then(_ => {}, _ => {}));
		
		return bp;
	}

	public buildAll( targetNames:string[], ctx:MiniBuildContext ) : Promise<BuildResult> {
		targetNames = deduplicate(targetNames);
		
		if( this.concurrencyMode == 'serial' ) {
			let p : Promise<BuildResult> = Promise.resolve({mtime: -Infinity});
			for( const targetName of targetNames ) {
				p = p.then(latest => {
					//this.logger.log(`builtAll: starting build for ${targetName}...`);
					return this.build(targetName, ctx).then( result => {
						//this.logger.log(`buildAll: ${targetName} built`);
						return { mtime: Math.max(latest.mtime, result.mtime) };
					});
				});
			}
			return p;
		} else {
			//this.logger.log(`buildAll: Starting parallel builds for ${targetNames.join(', ')}`);
			return Promise.all(targetNames.map(tn => this.build(tn, ctx))).then( results => {
				return results.reduce( (a,b) => ({
					mtime: Math.max(a.mtime, b.mtime)
				}), {mtime: -Infinity})
			})
		}
	}
	
	/**
	 * Process command-line arguments.
	 * Returns a rejected promise if there are problems.
	 */
	public parseCommandLineArgs(args:string[]):Promise<BuildParameters> {
		let targetNames = [];
		let buildOperation : BuildOperationName = 'build';
		let targetsSpecifiedVia = "command-line";
		let concurrencyMode = this.concurrencyMode;
		let verbosity = VERBOSITY_WARNINGS;
		let m : RegExpExecArray|null;
		for( let i=0; i<args.length; ++i ) {
			const arg = args[i];
			if( arg == '--list-targets' ) {
				buildOperation = 'list-targets';
			} else if( arg == '--describe-targets' ) {
				buildOperation = 'describe-targets';
			} else if( arg == '--help' ) {
				buildOperation = 'print-help';
			} else if( arg == '--serial' ) {
				concurrencyMode = "serial";
			} else if( arg == '--parallel' ) {
				concurrencyMode = "parallel";
			} else if( arg == '-v' ) {
				verbosity = VERBOSITY_INFO;
			} else if( arg == '-q' ) {
				verbosity = VERBOSITY_ERRORS;
			} else if( (m = /--verbosity=(\d+)$/.exec(arg)) != null ) {
				verbosity = +m[1];
			} else if( arg.startsWith("-") ) {
				return Promise.reject(new Error(`Unrecognized argument: ${arg}`));
			} else {
				// Make tab-completing on Windows not screw us all up!
				targetNames.push(arg.replace(/\\/g,'/'));
			}
		}
		
		if( targetNames.length == 0 ) {
			targetNames = this.defaultTargetNames;
			targetsSpecifiedVia = "(default targets)";
		}

		return Promise.resolve({
			buildOperation,
			targetNames,
			targetsSpecifiedVia,
			verbosity,
			concurrencyMode,
		})
	}

	public run(buildParams:BuildParameters) : Promise<void> {
		this.logger = new LevelFilteringLogger(this.configuredLogger, buildParams.verbosity);
		if( buildParams.concurrencyMode ) {
			if( this.concurrencyMode == 'serial' && buildParams.concurrencyMode == 'parallel' ) {
				// TODO: separate default vs allowed concurrency modes.
				this.logger.warn(`Caller indicated they would like --parallel, but this builder was configured as serial,`);
				this.logger.warn(`which may be for important reasons; ignoring --parallel option.`);
			} else {
				this.concurrencyMode = buildParams.concurrencyMode;
			}
		}

		switch( buildParams.buildOperation ) {
		case 'list-targets':
			return this.fetchAllBuildRules().then( (targets):void => {
				for( const n in targets ) console.log(n);
			});
		case 'describe-targets':
			return this.fetchAllBuildRules().then( (targets):void => {
				let lengthOfLongestTargetName = 0;
				for( const targetName in targets ) {
					lengthOfLongestTargetName = Math.max(targetName.length, lengthOfLongestTargetName);
				}
				const nlReplacement = "\n" + " ".repeat(lengthOfLongestTargetName)+" ; ";
				for( const targetName in targets ) {
					const target = targets[targetName];
					let text = targetName;
					if( target.description ) text += " ".repeat(lengthOfLongestTargetName-targetName.length)+" ; " + target.description.replaceAll("\n", nlReplacement);
					console.log(text);
				}
				if( this.defaultTargetNames.length > 0 ) {
					console.log("");
					console.log(`Default targets: ${this.defaultTargetNames.join(' ')}`);
				} else {
					console.log("");
					console.log("There are no default targets");
				}
			});
		case 'build':
			if( buildParams.targetNames.length == 0 ) {
				this.logger.warn("No build target build targets.  Try with --list-targets.");
				return Promise.resolve();
			}
			{
				const ctx = {buildRuleTrace: [buildParams.targetsSpecifiedVia]};
				return this.buildAll(buildParams.targetNames, ctx).then( () => {} );
			}
		case 'print-help':
			{
				console.log(`Usage:`);
				console.log(`  ${this.buildScriptName} --help              ; print this text`);
				console.log(`  ${this.buildScriptName} --list-targets      ; print target names, one-per-line`);
				console.log(`  ${this.buildScriptName} --describe-targets  ; print target descriptions`);
				console.log(`  ${this.buildScriptName} <options> <target>* ; build targets`);
				console.log(`Build options:`);
				console.log(`  -q         ; quiet; only errors/warnings will be printed`);
				console.log(`  -v         ; verbose logging`);
				console.log(`  --serial   ; build only one target at a time`);
				console.log(`  --parallel ; run build functions in parallel`);
				return Promise.resolve();
			}
		default:
			return Promise.reject(new Error("Bad operation: '"+(buildParams.buildOperation as BuildOperationName)+"'"));
		}
	}

	/**
	 * Parse command-line options and do the build, all in one step.
	 * @param args command-line arguments (e.g. Deno.args; not including the program or script name)
	 * @returns 
	 * @deprecated You probably want processCommandLine(...) instead, or parseCommandLineArgs(...).then(params => run(params)).
	 */
	public processArgsAndBuild(args:string[]):Promise<void> {
		return this.parseCommandLineArgs(args).then(buildParams => this.run(buildParams));
	}

	/** Return a promise that resolves when all build tasks have settled */
	public join() : Promise<void> {
		if( this.allBuildPromisesSettled === RESOLVED_VOID_PROMISE ) {
			// Short-circuit to avoid logging when no building actually happened
			return RESOLVED_VOID_PROMISE;
		}

		this.logger.log("Waiting for any running tasks to settle...");
		const settlePromise = this.allBuildPromisesSettled;
		return settlePromise.then( () => {
			if( this.allBuildPromisesSettled !== settlePromise ) {
				this.logger.log("New tasks spawned while waiting; waiting for them to settle...");
				return this.join();
			}
			this.logger.log("All build tasks settled.");
		});
	}

	/**
	 * Takes promise returned by run(), waits for the result,
	 * prints any appropriate output,
	 * waits for all tasks to finish,
	 * and returns a number appropriate for a process exit code.
	 * @param res
	 */
	public runResultToCommandLineResult(res:Promise<void>) : Promise<number> {
		return res.then( () => {
			if( this.allBuildPromisesSettled !== RESOLVED_VOID_PROMISE ) this.logger.log("Build completed");
			return 0;
		}, (err:Error) => {
			if( hasBuildTrace(err) ) {
				console.error(`Error while building ${err.tdBuildTrace[err.tdBuildTrace.length-1] || '(nothing?)'}:`, err.stack ?? err.message);
				console.error(`Trace: ${err.tdBuildTrace.join(' > ')}`);
			} else {
				console.error("Error!", err.stack ?? err.message);
			}
			console.error("Build failed!");
			return 1;
		}).finally(() => {
			this.isShuttingDown = true;
			return this.join()
		});
	}
	
	/**
	 * Parse command-line options, execute specified tasks, print results,
	 * wait for outstanding tasks to settle, and returns an appropriate exit code.
	 */
	public processCommandLine(args:string[]) : Promise<number> {
		return this.parseCommandLineArgs(args).then(buildParams => this.runResultToCommandLineResult(this.run(buildParams)));
	}
}
