import { mtimeR, touchDir } from './FSUtil.ts';
import Logger, {NULL_LOGGER} from './Logger.ts';

type BuildResult = { mtime: number };
type BuildFunction = (ctx:BuildContext) => Promise<void>;

export interface MiniBuilder {
	build( targetName:string, stackTrace:string[] ) : Promise<BuildResult>;
}

export interface BuildContext {
	builder: MiniBuilder;
	logger: Logger;
	prereqNames: string[];
	targetName: string;
}

type TargetTypeName = "directory"|"file"|"phony"|"auto";

export interface BuildRule {
	description?: string;
	/** a list of names of targets that must be built before this build rule can be invoked */
	prereqs?: string[]|AsyncIterable<string>;

	/** Function to invoke to build the target */
	invoke? : BuildFunction;
	/** An alternative to invoke: a system command to be run */
	cmd?: string[],

	// Metadata to allow Builder to automatically fix existence or mtime:

	/** If false, the target will be removed if the build rule fails */
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

function getRuleTargetType(rule:BuildRule, targetName:string) : TargetTypeName {
	if( rule.isDirectory !== undefined && rule.targetType !== undefined ) {
		throw new Error(`Rule for target '${targetName}' specifies both isDirectory and targetType`);
	}
	if( rule.targetType !== undefined ) return rule.targetType;
	return "auto";
}

function getRuleBuildFunction(rule:BuildRule, targetName:string) : BuildFunction|undefined {
	if( rule.cmd && rule.invoke ) {
		throw new Error(`Rule for target '${targetName}' indicates both invoke() and a cmd!`);
	}
	if( rule.invoke ) return rule.invoke;
	const cmd = rule.cmd;
	if( cmd ) {
		return async (ctx:BuildContext) => {
			ctx.logger.log(`Running \`${prettyCmd(cmd)}\`...`);
			let status : Deno.ProcessStatus;
			try {
				const proc = await Deno.run({cmd});
				status = await proc.status();
			} catch( e ) {
				const message = e.message || ""+e;
				throw new Error(`Failed to run command: \`${prettyCmd(cmd)}\`: ${message}`);
			}
			if( !status.success ) {
				throw new Error(`\`${prettyCmd(cmd)}\` exited with status ${status.code}`);
			}
		}
	}
	return undefined;
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

	protected verifyTarget( targetName:string, targetType:string ) : Promise<void> {
		switch(targetType) {
		case "file":
			this.logger.log("Verifying that "+targetName+" is a regular file...");
			return Deno.stat(targetName).then( stat => {
				if( !stat.isFile ) {
					return Promise.reject(`Target '${targetName}' should be a regular file, but is not`);
				}
			}, (err:Error) => {
				if( err.name == "NotFound" ) {
					return Promise.reject(`Target '${targetName}' is a file, but did not exist after building`);
				}
				return Promise.reject(err);
			});
		case "directory":
			this.logger.log("Verifying that "+targetName+" is a directory...");
			return Deno.stat(targetName).then( stat => {
				if( !stat.isDirectory ) {
					return Promise.reject(`Target '${targetName}' should be a directory, but is not`);
				}
			}, (err:Error) => {
				if( err.name == "NotFound" ) {
					return Promise.reject(`Target '${targetName}' is a file, but did not exist after building`);
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
	
	protected async buildTarget( targetName:string, rule:BuildRule, parentStackTrace:string[] ):Promise<BuildResult> {
		const targetType = getRuleTargetType(rule, targetName);
		let targetMtime = targetType == "phony" ? -Infinity : await mtimeR(targetName, -Infinity).catch( (e:Error) => {
			if( e.name == "NotFound" ) return -Infinity;
			return Promise.reject(e);
		});
		const stackTrace = parentStackTrace.concat( targetName )
		
		const prereqNames:string[] = [];
		for( const prereqName of this.globalPrereqs ) {
			prereqNames.push(prereqName);
		}
		if( rule.prereqs ) {
			for await(const prereqName of rule.prereqs ) {
				prereqNames.push(prereqName);
			}
		}
		
		let prereqsBuilt = Promise.resolve(-Infinity);
		for( const prereqName of prereqNames ) {
			const prereqBuildPromise = this.build(prereqName, stackTrace);
			prereqsBuilt = prereqsBuilt.then(async latest => {
				const prereqArtifact = await prereqBuildPromise;
				return Math.max(latest, prereqArtifact.mtime);
			});
		}
		
		const latestPrereqMtime = await prereqsBuilt;
		
		if( targetMtime == -Infinity || latestPrereqMtime > targetMtime ) {
			this.logger.log("Building "+targetName+"...");
			const buildFunction = getRuleBuildFunction(rule, targetName);
			if( buildFunction ) {
				try {
					await buildFunction({
						builder: this,
						logger: this.logger,
						prereqNames,
						targetName,
					});
				} catch( err ) {
					console.error("Error trace: "+stackTrace.join(' > '));
					const rejection = Promise.reject(err);
					if( !rule.keepOnFailure ) {
						console.error("Removing "+targetName);
						return Deno.remove(targetName, {recursive:true}).then(() => rejection);
					}
					return rejection;
				}
			} else {
				this.logger.log(targetName+" has no build rule; assuming up-to-date");
			}

			this.logger.log("Build "+targetName+" complete!");

			await this.verifyTarget(targetName, targetType);
			await this.postProcessTarget(targetName, targetType);
			
			targetMtime = targetType == "phony" ? -Infinity : await mtimeR(targetName, -Infinity);
		} else {
			this.logger.log(targetName+" is already up-to-date");
		}
		
		return {
			mtime: targetMtime
		};
	}
	
	public build( targetName:string, stackTrace:string[] ) : Promise<BuildResult> {
		if( this.buildPromises[targetName] != undefined ) return this.buildPromises[targetName];
		
		return this.buildPromises[targetName] = this.fetchBuildRuleForTarget(targetName).then( rule => {
			if( rule == null ) {
				return mtimeR(targetName, "error").then( mtime => {
					this.logger.log(targetName+" exists but has no build rule; assuming up-to-date");
					return {mtime};
				}, _err => {
					return Promise.reject(new Error(targetName+" does not exist and I don't know how to build it."));
				});
			} else {
				return this.buildTarget(targetName, rule, stackTrace);
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
			} else {
				// Make tab-completing on Windows not screw us all up!
				buildList.push(arg.replace(/\\/,'/'));
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
			if( buildList.length == 0 ) {
				buildList = this.defaultTargetNames;
				if( buildList.length == 0 ) {
					this.logger.warn("No build target build targets.  Try with --list-targets.");
					return Promise.resolve();
				}
			}
			const buildProms = [];
			for( const i in buildList ) {
				buildProms.push(this.build(buildList[i], ["argv["+i+"]"]));
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
			console.error("Error!", err.message, err.stack);
			console.error("Build failed!");
			return 1;
		});
	}
}
