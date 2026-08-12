# create-stoneware

Scaffold a new [Stoneware](https://github.com/RANJEETJ06/Stoneware) project.

```sh
bunx create-stoneware my-site
# npx create-stoneware my-site   — also works
```

Then:

```sh
cd my-site
bun install
bun run dev
```

## Why this is a separate package

`bunx create-stoneware` and `npm create stoneware` both resolve to a package literally
named `create-stoneware`, so it cannot live inside the `stoneware` package.

It is deliberately plain JavaScript with a Node shebang and zero dependencies:
this is the one command someone runs *before* they have Stoneware, and possibly
before they have Bun. Requiring Bun to create the project would put the runtime
requirement in front of the thing that explains it.

The generated project is Bun-only — `stoneware dev` and `stoneware build` need it.
