import { mtimeR, touch } from './FSUtil.ts';
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

export interface BuildRule {
	description?: string;
	/** an async iterable list of names of targets that must be built before this build rule can be invokled */
	prereqs?: AsyncIterable<string>;

	// Function to invoke
	invoke? : BuildFunction;
	// Command to run as an alternative to invoke
	cmd?: string[],

	// Metadata to allow Builder to automatically fix existence or mtime
	keepOnFailure?: boolean;
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

function getRuleBuildFunction(rule:BuildRule, targetName:string) : BuildFunction|undefined {
	if( rule.cmd && rule.invoke ) {
		throw new Error(`Rule for target '${targetName}' indicates both invoke() and a cmd!`);
	}
	if( rule.invoke ) return rule.invoke;
	const cmd = rule.cmd;
	if( cmd ) {
		return async (ctx:BuildContext) => {
			ctx.logger.log(`Running \`${prettyCmd(cmd)}\`...`);
			const proc = await Deno.run({cmd});
			const status = await proc.status();
			if( !status.success ) {
				throw new Error(`\`${prettyCmd(cmd)}\` exited with status ${status.code}`);
			}
		}
	}
	return undefined;
}

export default class Builder implements MiniBuilder {
	/**
	 * List of things to always consider prereqs,
	 * such as the build script itself.
	 */
	public globalPrereqs:string[] = [];

	protected logger:Logger = NULL_LOGGER;
	protected buildPromises:{[name:string]: Promise<BuildResult>} = {};
	public defaultTargetNames:string[] = [];

	public constructor(public targets:{[name:string]: BuildRule}={}) {
	}

	/** Here so you can override it */
	protected fetchGeneratedTargets():Promise<{[name:string]:BuildRule}> {
		return Promise.resolve({});
	}

	protected allTargetsPromise:Promise<{[name:string]:BuildRule}>|undefined = undefined;
	protected async fetchAllTargets() : Promise<{[name:string]:BuildRule}> {
		if( this.allTargetsPromise ) return this.allTargetsPromise;
		
		const allTargets:{[name:string]:BuildRule} = {};
		for( const n in this.targets ) allTargets[n] = this.targets[n];
		const generatedTargets = await this.fetchGeneratedTargets();
		for( const n in generatedTargets ) allTargets[n] = generatedTargets[n];
		return allTargets;
	}

	protected fetchBuildRuleForTarget( targetName:string ):Promise<BuildRule> {
		return this.fetchAllTargets().then( (targets) => targets[targetName] );
	}

	protected async buildTarget( targetName:string, rule:BuildRule, stackTrace:string[] ):Promise<BuildResult> {
		let targetMtime = await mtimeR(targetName, -Infinity).catch( (e:Error) => {
			if( e.name == "NotFound" ) return -Infinity;
			return Promise.reject(e);
		});
		const prereqStackTrace = stackTrace.concat( targetName )
		const prereqNames:string[] = [];
		let prereqsBuilt = Promise.resolve(-Infinity);
		if( rule.prereqs ) {
			for await(const prereqName of rule.prereqs ) {
				prereqNames.push(prereqName);
				const prereqBuildPromise = this.build(prereqName, prereqStackTrace);
				prereqsBuilt = prereqsBuilt.then(async latest => {
					const prereqArtifact = await prereqBuildPromise;
					return Math.max(latest, prereqArtifact.mtime);
				});
			}
		}
		const latestPrereqMtime = await prereqsBuilt;
		if( targetMtime == -Infinity || latestPrereqMtime > targetMtime ) {
			this.logger.log("Building "+targetName+"...");
			const buildFunction = getRuleBuildFunction(rule, targetName);
			if( buildFunction ) {
				await buildFunction({
					builder: this,
					logger: this.logger,
					prereqNames,
					targetName,
				}).then( () => {
					this.logger.log("Build "+targetName+" complete!");
					if( rule.isDirectory ) {
						return touch(targetName);
					}
				}, (err:Error) => {
					console.error("Error trace: "+stackTrace.join(' > ')+" > "+targetName);
					const rejection = Promise.reject(err);
					if( !rule.keepOnFailure ) {
						console.error("Removing "+targetName);
						return Deno.remove(targetName, {recursive:true}).then(() => rejection);
					}
					return rejection;
				});
				targetMtime = await mtimeR(targetName, -Infinity);
			} else {
				this.logger.log(targetName+" has no build rule; assuming up-to-date");
			}
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
		
		if( verbosity >= 200 ) {
			this.logger = console;
		} else if( verbosity >= 100 ) {
			this.logger = {
				log: () => {},
				warn: console.warn,
				error: console.error,
			}
		} else {
			this.logger = NULL_LOGGER;
		}
		
		if( operation == 'list-targets' ) {
			return this.fetchAllTargets().then( (targets):void => {
				for( const n in targets ) console.log(n);
			});
		} else if( operation == 'describe-targets' ) {
			return this.fetchAllTargets().then( (targets):void => {
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
