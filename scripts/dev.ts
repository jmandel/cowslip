await import("./build");

export {};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file("dist/index.html"));
  },
});

console.log(`Sow's Ear dev server: http://localhost:${server.port}`);
