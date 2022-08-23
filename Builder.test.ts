import { assertEquals } from 'https://deno.land/std@0.119.0/testing/asserts.ts';
import { AlternateMtimeFunction, BuilderOptions, BuildContext } from './Builder.ts';
import Builder from './Builder.ts';
import { splitPath } from './FSUtil.ts';

Deno.test("custom mtime function works", async () => {
	function makeSidecarMtimeFunction(sidecarPathFunction:(path:string)=>string) : AlternateMtimeFunction {
		return (path:string) => {
			const sidecarPath = sidecarPathFunction(path);
			return Deno.readTextFile(sidecarPath).then(
				text => +text.trim(),
				err => {
					if( err.name == "NotFound" ) return undefined;
					return Promise.reject(err);
				}
			);
		}
	}

	const opts : BuilderOptions = {
		mtimeFunction: makeSidecarMtimeFunction( (path:string) => {
			const pathParts = splitPath(path);
			return pathParts.dir + "/." + pathParts.name + ".mtime";
		}),
		//logger: console,
		rules: {
			"test-data/file-c.txt": {
				prereqs: ["test-data/file-a.txt", "test-data/file-b.txt"],
				invoke(ctx:BuildContext) : Promise<void> {
					return Deno.writeTextFile(ctx.targetName, "C is built!");
				}
			}
		}
	};

	await Promise.all([
		Deno.writeTextFile("test-data/.file-a.txt.mtime", "100"),
		Deno.writeTextFile("test-data/.file-b.txt.mtime", "200"),
		Deno.writeTextFile("test-data/.file-c.txt.mtime", "300"),
		Deno.writeTextFile("test-data/file-c.txt", "C is NOT built!"),
	]);

	let builder = new Builder(opts);
	await builder.build("test-data/file-c.txt", {
		buildRuleTrace: ["first (non) build of file-c.txt"]
	});

	assertEquals("C is NOT built!", await Deno.readTextFile("test-data/file-c.txt"), "Expected file-c.txt not to be built when its fake mtime is greater than that of dependencies");

	// Make file-c.txt look older than a and b!
	await Promise.all([
		Deno.writeTextFile("test-data/.file-c.txt.mtime", "50"),
	]);

	builder = new Builder(opts);
	await builder.build("test-data/file-c.txt", {
		buildRuleTrace: ["second build of file-c.txt"]
	});

	const fakeMtimeContents = await Promise.all(
		["a","b","c"].map( l => Deno.readTextFile(`test-data/.file-${l}.txt.mtime`))
	);

	assertEquals("C is built!", await Deno.readTextFile("test-data/file-c.txt"),
		"Expected C to be built if fake mtime file indicated a lower value than that of dependencies: "+
		JSON.stringify(fakeMtimeContents)+", respectively");
});
