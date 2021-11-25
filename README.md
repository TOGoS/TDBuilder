# TDBuilder: A build system using Deno

Using TDBuilder you can specify rules for building files or directories,
or running other tasks.

It is based on https://github.com/TOGoS/NodeBuildUtil.

TDBuilder does not do anything by itself, but can be used by a script,
which you might call `make.ts`, which might look something like this:

```
import Builder from 'https://deno.land/x/tdbuilder@0.3.4/Builder.ts';

const builder = new Builder({
	rules: {
		"hello-world.txt": {
			description: "An example text file",
			invoke(ctx:BuildContext) {
				Deno.writeTextFile(ctx.targetName, "Hello, world!\n");
				return Promise.resolve();
			}
		},
		// A rule to build foobar.txt is not specified,
		// so it must be present already, e.g. committed to the project repo.
		"concatenation.txt": {
			description: "An example of a rule with prerequisites",
			prereqs: ["hello-world.txt", "foobar.txt"],
			async invoke(ctx:BuildContext) {
				const allContent = await Promise.all(ctx.prereqNames.map(file => Deno.readTextFile(file)))
				return Deno.writeTextFile(ctx.targetName, allContent.join(""));
			}
		},
		"test": {
			description: "Run all unit tests!",
			cmd: [Deno.execPath(),"test", "--allow-read=src", "src/test/deno"]
		}
	},
	logger: console,
	// If the user just runs `deno run make.ts`, we'll build the listed targets:
	defaultTargetNames: ["concatenation.txt","test"]
});
Deno.exit(await builder.processCommandLine(Deno.args));
```

The build rules and related API look like this:

```
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
}
```

There is currently (as of 0.3.4) no way to indicate a build rule that builds multiple targets.
As a workaround, define one of the targets (preferrably a non-phony one) and list it as a prerequisite for the others.

Rules are run in parallel as much as possible.
Lock a mutex in `invoke()` if you want to prevent certain build steps from
running at the same time.

Normally you shouldn't need to reference `ctx.builder`,
but you can if you need to dynamically request to build a prerequisite.

Run your script with `-v` to generate some info on the console about targets being built.
