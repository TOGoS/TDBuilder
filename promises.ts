declare function Symbol(x:string):symbol;

enum State {
	NORMAL,
	RESOLVED,
	REJECTED
} 

const STATESYM = Symbol("resolved");
const VALUESYM = Symbol("value");

export const RESOLVED_UNKNOWN_PROMISE:Promise<unknown> = resolvedPromise<void>(undefined);

export function resolvedPromise<T>( value:T ) : Promise<T> {
	const p = Promise.resolve(value);
	// deno-lint-ignore no-explicit-any
	(p as any)[VALUESYM] = value;
	// deno-lint-ignore no-explicit-any
	(p as any)[STATESYM] = State.RESOLVED;
	return p;
}

export function finalmente<T>( p:Promise<T>, finalStuff:()=>void ):Promise<T> {
	return p.then(
		(v) => { finalStuff(); return v; },
		(err) => { finalStuff(); return Promise.reject(err); }
	);
}
