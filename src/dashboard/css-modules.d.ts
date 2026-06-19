// Side-effect CSS imports (the dashboard widget ships its stylesheet). vite
// turns these into a bundled <link>; tsc only needs to know the specifier
// resolves. tsconfig pins `types` to workers-types, so vite/client's ambient
// declarations aren't in scope — declare the shape we use here.
declare module '*.css'
