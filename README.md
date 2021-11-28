# TDBuilder: A build system using Deno

Using TDBuilder you can specify rules for building files or directories,
or running other tasks.

Similar to Make, non-phony targets will be compared with their prerequisites
based on `mtime` to determine if they need to be rebuilt.

Some differences from Make:
- Deno instead of `$SHELL`, so you don't need to worry so much about the quirks of the target platform.
  - Also, it won't be tripped up by filenames that contain spaces.
- When comparing modification times, directories are considered as new as the newest contained file,
  so you don't need silly things like `some_target: $(shell find some_source_directory)`

It is based on https://github.com/TOGoS/NodeBuildUtil.

TDBuilder does not do anything by itself, but can be used by a script,
which you might call `make.ts`, which might look something like this:

```
import Builder from 'https://deno.land/x/tdbuilder@0.5.0/Builder.ts';

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
	// If the user just runs `deno run --allow-all make.ts`, we'll build these targets:
	defaultTargetNames: ["concatenation.txt","test"]
});
Deno.exit(await builder.processCommandLine(Deno.args));
```

There is currently (as of 0.5.0) no way to indicate a build rule that builds multiple targets.
As a workaround, define one of the targets (preferrably a non-phony one) and list it as a prerequisite for the others.

Rules are run in parallel as much as possible.
If you with to prevent some build rules from running simultaneously,
you can use a mutex (implementation detail left to you for now),
either in `invoke()` or added by the `buildFunctionTransformer`.

Normally you shouldn't need to reference `ctx.builder`,
but you can if you need to dynamically request to build a prerequisite.

Targets are only ever built once per Builder instance.

Run your script with `-v` to generate some info on the console about targets being built.
