import { RESOLVED_UNKNOWN_PROMISE } from './promises.ts';

export type FilePath = string;

export function mkParentDirs( file:FilePath ):Promise<unknown> {
	const comps = file.split('/');
	if( comps.length > 1 ) {
		const dir = comps.slice(0,comps.length-1).join('/');
		return Deno.mkdir(dir, {recursive:true});
	} else {
		return RESOLVED_UNKNOWN_PROMISE;
	}
}

/*
Too unstable!
export function touch( fileOrDir:FilePath ) : Promise<void> {
	const curTime = Date.now();
	return Deno.utime(fileOrDir, curTime, curTime);
}
*/

export function touchDir( dir:FilePath ) : Promise<void> {
	const touchyFile = `${dir}/.touchy-touchy.txt`;
	return Deno.writeTextFile(touchyFile,
		"This file was written to update the modification time on the containing directory.\n"+
		"It should have been deleted immediately.\n"+
		"In case it was not, feel free to delete it.\n"
	).then(() => Deno.remove(touchyFile));
}

export async function cpR( src:FilePath, dest:FilePath ):Promise<unknown> {
	const srcStat = await Deno.stat(src);
	if( srcStat.isDirectory ) {
		await Deno.mkdir(dest, {recursive:true});
		let copyPromise = RESOLVED_UNKNOWN_PROMISE;
		for await(const entry of Deno.readDir(src)) {
			const entryCopyPromise = cpR(src+"/"+entry.name, dest+"/"+entry.name);
			copyPromise = copyPromise.then(() => entryCopyPromise);
		}
		return copyPromise;
	} else {
		return Deno.copyFile(src, dest);
	}
}

export function cpRReplacing( src:FilePath, dest:FilePath ):Promise<unknown> {
	return Deno.remove(dest, {recursive:true}).then( () => cpR(src,dest) );
}

export async function mtimeR(path:string, onNotFound:number|"error", returnInfinityIfGtThis=Infinity) : Promise<number> {
	let rootStat : Deno.FileInfo;
	try {
		rootStat = await Deno.stat(path);
	} catch( e ) {
		if( e instanceof Error && e.name == "NotFound" && onNotFound != "error" ) {
			return onNotFound;
		}
		throw e;
	}
	let latest = rootStat.mtime?.getTime() ?? -Infinity;
	if( latest > returnInfinityIfGtThis ) return Infinity;
	let dp = Promise.resolve();
	if( rootStat.isDirectory ) {
		for await( const entry of Deno.readDir(path) ) {
			if( entry.name == "." || entry.name == ".." ) {
				console.info(`latestMtime: Info: Deno.readDir results include '${entry.name}'`);
				continue;
			}
			dp = dp.then(() => mtimeR(path + "/" + entry.name, onNotFound, returnInfinityIfGtThis)).then(mt => {
				latest = Math.max(latest, mt);
			});
		}
	}
	await dp;
	return latest;
}

/** Make a file (or directory if options.recursive) be removed, even if it didn't exist */
export function makeRemoved(path:string|URL, options?: Deno.RemoveOptions) : Promise<void> {
	return Deno.remove(path, options).catch( err => {
		if( err.name == 'NotFound' ) {
			// This is fine.
		} else {
			return Promise.reject(err);
		}
	})
}
