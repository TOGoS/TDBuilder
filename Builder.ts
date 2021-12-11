// deno-lint-ignore-file no-explicit-any
import { mtimeR, touchDir, makeRemoved } from './FSUtil.ts';
import Logger, {NULL_LOGGER} from './Logger.ts';

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
	rules? : {[targetName:string]: BuildRule},
	/** The logger that the builder will use.  Defaults to `NULL_LOGGER` */
	logger? : Logger,
	/** List of targets that should always be built */
	globalPrerequisiteNames? : string[],
	/** Names of targets that should be assumed when none are specified on the command-line */
	defaultTargetNames? : string[],
}

/**
 * Anything, but generally an exception object,
 * that has a build trace consisting of the names of build targets
 * that were being built which led to the error.
 */
interface HasBuildTrace {
	tdBuildTrace : string[];
}

function hasBuildTrace(x:any) : x is HasBuildTrace {
	return Array.isArray(x.tdBuildTrace) && (x.tdBuildTrace as any[]).reduce(
		(p:boolean, v:any) => p && typeof(v) == 'string',
		true
	);
}

export class BuildError extends Error implements HasBuildTrace {
	constructor(message:string, public tdBuildTrace:string[]) {
		super(message);
	}
}

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
	protected logger:Logger;

	protected buildPromises:{[name:string]: Promise<BuildResult>} = {};
	
	public constructor(opts:BuilderOptions={}) {
		this.buildRules = opts.rules || {};
		this.logger = opts.logger || NULL_LOGGER;
		this.globalPrereqs = opts.globalPrerequisiteNames || [];
		this.defaultTargetNames = opts.defaultTargetNames || [];
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
		
		let prereqsBuilt = Promise.resolve(-Infinity);
		for( const prereqName of prereqNames ) {
			const prereqBuildPromise = this.build(prereqName, {buildRuleTrace});
			prereqsBuilt = prereqsBuilt.then(async latest => {
				const prereqArtifact = await prereqBuildPromise;
				return Math.max(latest, prereqArtifact.mtime);
			});
		}
		
		const latestPrereqMtime = await prereqsBuilt;
		
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
							console.error("Removing "+targetName);
							return makeRemoved(targetName, {recursive:true}).then(() => rejection);
						case "keep":
							console.log("Keeping "+targetName+" despite failure");
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
		
		return this.buildPromises[targetName] = this.fetchBuildRuleForTarget(targetName).then( rule => {
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
	}
	
	/**
	 * Process command-line arguments.
	 * Returns a rejected promise if there are problems.
	 */
	public processArgsAndBuild(args:string[]):Promise<void> {
		let buildList = [];
		let operation = 'build';
		let verbosity = 100;
		for( let i=0; i<args.length; ++i ) {
			const arg = args[i];
			if( arg == '--list-targets' ) {
				operation = 'list-targets';
			} else if( arg == '--describe-targets' ) {
				operation = 'describe-targets';
			} else if( arg == '-v' ) {
				verbosity = 200;
			} else if( arg == '-q' ) {
				verbosity = 0;
			} else {
				// Make tab-completing on Windows not screw us all up!
				buildList.push(arg.replace(/\\/g,'/'));
			}
		}
		
		const configuredLogger = this.logger;
		if( verbosity >= 200 ) {
			this.logger = configuredLogger;
		} else if( verbosity >= 100 ) {
			this.logger = {
				log: () => {},
				warn: configuredLogger.warn,
				error: configuredLogger.error,
			}
		} else {
			this.logger = NULL_LOGGER;
		}
		
		if( operation == 'list-targets' ) {
			return this.fetchAllBuildRules().then( (targets):void => {
				for( const n in targets ) console.log(n);
			});
		} else if( operation == 'describe-targets' ) {
			return this.fetchAllBuildRules().then( (targets):void => {
				// TODO: Print prettier and allowing for multi-line descriptions
				for( const targetName in targets ) {
					const target = targets[targetName];
					let text = targetName;
					if( target.description ) text += " ; " + target.description;
					console.log(text);
				}
			});
		} else if( operation == 'build' ) {
			let specifiedVia = "(command-line)";
			if( buildList.length == 0 ) {
				buildList = this.defaultTargetNames;
				if( buildList.length == 0 ) {
					this.logger.warn("No build target build targets.  Try with --list-targets.");
					return Promise.resolve();
				}
				specifiedVia = "(default targets)"
			}
			const buildProms = [];
			for( const i in buildList ) {
				buildProms.push(this.build(buildList[i], {buildRuleTrace: [specifiedVia]}));
			}
			return Promise.all(buildProms).then( () => {} );
		} else {
			return Promise.reject(new Error("Bad operation: '"+operation+"'"));
		}
	}
	
	/**
	 * Process command-line options,
	 * duimping any error messages to console.error and
	 * returning the appropriate exit code given the result of trying to build,
	 * which it is recommended you pass to Deno.exit.
	 */
	public processCommandLine(argv:string[]) : Promise<number> {
		return this.processArgsAndBuild(argv).then( () => {
			this.logger.log("Build completed");
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
		});
	}
}
