import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeFixture } from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";
const HTML = { Accept: "text/html,application/xhtml+xml" };

Deno.test("files of the web directory are served without caching", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/assets/app.js`),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-cache");
    assertStringIncludes(await response.text(), "console.log(1);");
  } finally {
    await fixture.close();
  }
});

Deno.test("a client route answers with index.html when HTML is accepted", async () => {
  const fixture = await makeFixture();
  try {
    for (const path of ["/", "/n/note1abc", "/p/npub1xyz", "/network"]) {
      const response = await fixture.handler(
        new Request(`${BASE}${path}`, { headers: HTML }),
      );
      assertEquals(response.status, 200, path);
      assertEquals(response.headers.get("cache-control"), "no-cache");
      assertStringIncludes(await response.text(), "<title>client</title>");
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("a missing path is 404 JSON when HTML is not accepted", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/n/note1abc`, {
        headers: { Accept: "application/json" },
      }),
    );
    assertEquals(response.status, 404);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("other methods on the web client are 404 JSON", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/assets/app.js`, { method: "DELETE" }),
    );
    assertEquals(response.status, 404);
    assertEquals(
      (await response.json()).error,
      "not found",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("a missing build answers 503 for HTML requests", async () => {
  const fixture = await makeFixture({ built: false });
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/`, { headers: HTML }),
    );
    assertEquals(response.status, 503);
    assertEquals(
      await response.text(),
      "The web client has not been built. Run `deno task build`.",
    );

    const asset = await fixture.handler(new Request(`${BASE}/assets/app.js`));
    assertEquals(asset.status, 404);
    await asset.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("paths cannot escape the web directory", async () => {
  const fixture = await makeFixture();
  try {
    const secret = "top secret outside the web directory";
    await Deno.writeTextFile(`${fixture.root}/secret.txt`, secret);

    const attempts = [
      "/%2e%2e/secret.txt",
      "/%2E%2E/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%00",
      "/%E0%A4%A",
    ];
    // Whatever is asked, the answer is a 404 or the client's index.html.
    for (const path of attempts) {
      for (const headers of [undefined, HTML]) {
        const response = await fixture.handler(
          new Request(`${BASE}${path}`, { headers }),
        );
        const text = await response.text();
        assert(!text.includes(secret), path);
        if (response.status === 200) {
          assertStringIncludes(text, "<title>client</title>", path);
        } else {
          assertEquals(response.status, 404, path);
        }
      }
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("the client is served to requests without an HTML preference", async () => {
  const fixture = await makeFixture();
  try {
    for (const headers of [undefined, { accept: "*/*" }]) {
      const response = await fixture.handler(
        new Request(`${BASE}/p/npub1example`, { headers }),
      );
      assertEquals(response.status, 200);
      assertStringIncludes(await response.text(), "<title>client</title>");
    }
    const asset = await fixture.handler(
      new Request(`${BASE}/assets/missing.js`, { headers: HTML }),
    );
    assertEquals(asset.status, 404);
    await asset.text();
    const data = await fixture.handler(
      new Request(`${BASE}/p/npub1example`, {
        headers: { accept: "application/json" },
      }),
    );
    assertEquals(data.status, 404);
    await data.text();
  } finally {
    await fixture.close();
  }
});
