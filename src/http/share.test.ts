import { assertEquals } from "@std/assert";
import { makeFixture } from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";

Deno.test("a shared form is redirected to the share view with its fields", async () => {
  const fixture = await makeFixture();
  try {
    const form = new FormData();
    form.set("title", "A page");
    form.set("text", "");
    form.set("url", "https://example.org/a?b=c");
    const response = await fixture.handler(
      new Request(`${BASE}/share`, { method: "POST", body: form }),
    );
    assertEquals(response.status, 303);
    const location = new URL(response.headers.get("location")!, BASE);
    assertEquals(location.pathname, "/share");
    assertEquals(location.searchParams.get("title"), "A page");
    assertEquals(location.searchParams.get("url"), "https://example.org/a?b=c");
    assertEquals(location.searchParams.has("text"), false);
    assertEquals(location.searchParams.has("files"), false);
  } finally {
    await fixture.close();
  }
});

Deno.test("shared files are dropped and the view is told so", async () => {
  const fixture = await makeFixture();
  try {
    const form = new FormData();
    form.set("text", "look");
    form.append("files", new File([new Uint8Array(10)], "a.png"));
    const response = await fixture.handler(
      new Request(`${BASE}/share`, { method: "POST", body: form }),
    );
    assertEquals(response.status, 303);
    const location = new URL(response.headers.get("location")!, BASE);
    assertEquals(location.searchParams.get("text"), "look");
    assertEquals(location.searchParams.get("files"), "dropped");
  } finally {
    await fixture.close();
  }
});

Deno.test("a share too large to read still lands on the share view", async () => {
  const fixture = await makeFixture();
  try {
    const form = new FormData();
    form.append("files", new File([new Uint8Array(512 * 1024)], "big.mp4"));
    const response = await fixture.handler(
      new Request(`${BASE}/share`, { method: "POST", body: form }),
    );
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), "/share?files=dropped");
  } finally {
    await fixture.close();
  }
});

Deno.test("the text of a share too large to read is kept", async () => {
  const fixture = await makeFixture();
  try {
    const form = new FormData();
    form.set("title", "Grüße");
    form.set("text", "line one\r\nline two");
    form.set("url", "https://example.org/a");
    form.append("files", new File([new Uint8Array(512 * 1024)], "big.mp4"));
    const response = await fixture.handler(
      new Request(`${BASE}/share`, { method: "POST", body: form }),
    );
    assertEquals(response.status, 303);
    const location = new URL(response.headers.get("location")!, BASE);
    assertEquals(location.searchParams.get("title"), "Grüße");
    assertEquals(location.searchParams.get("text"), "line one\r\nline two");
    assertEquals(location.searchParams.get("url"), "https://example.org/a");
    assertEquals(location.searchParams.get("files"), "dropped");
  } finally {
    await fixture.close();
  }
});
