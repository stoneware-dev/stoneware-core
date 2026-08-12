# create-sinter

Scaffold a new [Sinter](https://github.com/RANJEETJ06/Sinter) project.

```sh
bunx create-sinter my-site
# npx create-sinter my-site   — also works
```

Then:

```sh
cd my-site
bun install
bun run dev
```

## Why this is a separate package

`bunx create-sinter` and `npm create sinter` both resolve to a package literally
named `create-sinter`, so it cannot live inside the `sinter` package.

It is deliberately plain JavaScript with a Node shebang and zero dependencies:
this is the one command someone runs *before* they have Sinter, and possibly
before they have Bun. Requiring Bun to create the project would put the runtime
requirement in front of the thing that explains it.

The generated project is Bun-only — `sinter dev` and `sinter build` need it.
