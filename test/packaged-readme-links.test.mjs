import assert from "node:assert/strict";
import test from "node:test";

import {
  PackagedReadmeLinkError,
  assertPackagedReadmeLinks,
} from "../tools/packaged_readme_links.mjs";

const APPROVED =
  "https://example.invalid/open-rfc/reference?version=1&format=html#api";

function inspect(source, options = {}) {
  return assertPackagedReadmeLinks([
    { path: "package/README.md", bytes: Buffer.from(source) },
  ], options);
}

test("packaged README admits same-document links and exact approved HTTPS targets", () => {
  const result = inspect([
    "# Package",
    "Unicode before a link: 🦄 [unicode](#package)",
    "[inline](#package)",
    "![image](#package)",
    "[with title](#package \"Package\")",
    "[reference][package] and [collapsed][] and [shortcut]",
    "",
    "[package]: #package",
    "[collapsed]: <#package> 'Package'",
    "[shortcut]: #package",
    "",
    '<a href="#package">anchor</a><img src=#package>',
    `[approved](${APPROVED})`,
    `<${APPROVED}>`,
    "",
  ].join("\n"), { approvedHttpsTargets: [APPROVED] });

  assert.deepEqual(result, {
    readmePath: "package/README.md",
    approvedHttpsTargetCount: 1,
    anchorCount: 1,
    referenceDefinitionCount: 3,
    targetCount: 14,
  });
});

test("packaged README ignores link-like text in code and HTML comments", () => {
  assert.doesNotThrow(() => inspect([
    "`[inline code](../private)`",
    "",
    "```md",
    "[fenced](file:///private)",
    '<img src="/private">',
    "```",
    "<!-- [commented](docs/private.md) -->",
    "",
  ].join("\n")));
});

test("packaged README does not hide links behind mismatched code delimiters", () => {
  assert.throws(
    () => inspect("`` [rendered](../private) ```\n"),
    /packaged README:/u,
  );
});

test("packaged README keeps UTF-16 offsets aligned while masking references", () => {
  assert.throws(
    () => inspect([
      "# H",
      "🦄".repeat(10),
      "[safe]: #h",
      "[unsafe](../private)",
      "",
    ].join("\n")),
    /packaged README:/u,
  );
});

test("packaged README does not mask an invalid backtick fence info string", () => {
  assert.throws(
    () => inspect([
      "``` bad`info",
      "[unsafe](../private)",
      "```",
      "",
    ].join("\n")),
    /packaged README:/u,
  );
});

test("packaged README rejects reference definitions hidden in block containers", () => {
  for (const source of [
    "> [unsafe]: ../private\n\n[unsafe]\n",
    "- [unsafe]: ../private\n\n[unsafe]\n",
  ]) {
    assert.throws(() => inspect(source), /packaged README:/u);
  }
});

test("packaged README follows GFM fence and HTML comment semantics", () => {
  for (const source of [
    "\t```\n[unsafe](../private)\n```\n",
    "\\<!-- [unsafe](../private) -->\n",
    "<!--> [unsafe](../private) -->\n",
    "ftp://example.invalid/private\n",
  ]) {
    assert.throws(() => inspect(source), /packaged README:/u);
  }
});

test("packaged README rejects GFM bare URLs outside ignored code", () => {
  assert.throws(
    () => inspect("Rendered bare URL https://example.invalid/private\n"),
    /packaged README:/u,
  );
  assert.doesNotThrow(() => inspect([
    "```sh",
    "curl https://example.invalid/example-only",
    "```",
    "",
  ].join("\n")));
});

test("packaged README rejects every GFM extended bare autolink", () => {
  for (const source of [
    "Rendered bare host www.example.invalid/private\n",
    "Rendered bare email security@example.invalid\n",
    '<span style="background:url(https://example.invalid/track)">unsafe</span>\n',
  ]) {
    assert.throws(() => inspect(source), /packaged README:/u);
  }
});

test("packaged README rejects every non-fragment target class by default", async (t) => {
  const denied = [
    ["bare relative", "docs/guide.md"],
    ["dot relative", "./guide.md"],
    ["parent relative", "../guide.md"],
    ["absolute path", "/guide.md"],
    ["protocol relative", "//example.invalid/guide"],
    ["Windows path", "C:\\guide.md"],
    ["file URI", "file:///guide.md"],
    ["HTTP", "http://example.invalid/guide"],
    ["unapproved HTTPS", "https://example.invalid/guide"],
    ["mail", "mailto:security@example.invalid"],
    ["script", "javascript:alert(1)"],
    ["data", "data:text/plain,guide"],
  ];
  for (const [name, target] of denied) {
    await t.test(name, () => {
      assert.throws(
        () => inspect(`[target](<${target}>)\n`),
        PackagedReadmeLinkError,
      );
    });
  }
});

test("packaged README rejects encoded traversal and ambiguous encodings", async (t) => {
  for (const [name, target] of [
    ["encoded traversal", "%2e%2e%2fprivate"],
    ["double-encoded traversal", "%252e%252e%252fprivate"],
    ["encoded backslash", "docs%5cprivate"],
    ["encoded control", "#fragment%0aother"],
    ["malformed percent", "#fragment%zz"],
    ["non-UTF-8 percent", "#fragment%ff"],
  ]) {
    await t.test(name, () => {
      assert.throws(() => inspect(`[target](<${target}>)\n`), /packaged README:/u);
    });
  }
});

test("packaged README detects links in Markdown, references, autolinks, and HTML", async (t) => {
  const hostileSources = [
    ["inline image", "![image](docs/image.png)"],
    ["indented apparent link", "    [link](docs/guide.md)"],
    ["reference definition", "[guide]: docs/guide.md\n[read][guide]"],
    ["undefined reference", "[read][missing]"],
    ["URI autolink", "<file:///private>"],
    ["email autolink", "<security@example.invalid>"],
    ["HTML href", '<a href="docs/guide.md">read</a>'],
    ["HTML src", "<img src=/private>"],
    ["HTML entity target", '<a href="&sol;private">read</a>'],
    ["HTML srcset", '<img src="#one" srcset="#one 1x">'],
    ["quoted angle before href", '<a title=">" href="../private">read</a>'],
    ["quoted angle before src", '<img alt=">" src="/private">'],
  ];
  for (const [name, source] of hostileSources) {
    await t.test(name, () => {
      assert.throws(() => inspect(`${source}\n`), /packaged README:/u);
    });
  }
});

test("packaged README closes every same-document fragment over exact anchors", () => {
  assert.doesNotThrow(() => inspect([
    "# Encoded target",
    "[encoded](#encoded%2Dtarget)",
    '<a id="explicit-anchor"></a>',
    "[explicit](#explicit-anchor)",
    "",
  ].join("\n")));

  assert.throws(
    () => inspect("# Existing\n[missing](#not-present)\n"),
    /fragment without a matching anchor/u,
  );
  assert.throws(
    () => inspect("# Existing\n[encoded missing](#not%2Dpresent)\n"),
    /fragment without a matching anchor/u,
  );
  assert.throws(
    () => inspect("# Duplicate\n# Duplicate\n"),
    /duplicate Markdown or explicit anchor ID/u,
  );
  assert.throws(
    () => inspect('<a id="duplicate"></a>\n<a name="duplicate"></a>\n'),
    /duplicate Markdown or explicit anchor ID/u,
  );
});

test("packaged README rejects malformed targets and syntax", async (t) => {
  for (const [name, source] of [
    ["empty target", "[empty]()"],
    ["unclosed inline", "[bad](#fragment"],
    ["unclosed angle", "[bad](<#fragment)"],
    ["bad title", "[bad](#fragment title)"],
    ["unclosed reference", "[bad][reference"],
    ["duplicate reference", "[one]: #one\n[ONE]: #two"],
    ["malformed HTML attribute", "<a href>bad</a>"],
  ]) {
    await t.test(name, () => {
      assert.throws(() => inspect(`${source}\n`), /packaged README:/u);
    });
  }
});

test("packaged README binds the exact requested archive entry bytes", () => {
  const entries = [
    { path: "package/README.md", bytes: Buffer.from("# Safe\n\n[safe](#safe)\n") },
    {
      path: "package/node_modules/open-rfc/README.md",
      bytes: Buffer.from("# Embedded\n\n[embedded](#embedded)\n"),
    },
  ];
  assert.equal(assertPackagedReadmeLinks(entries).targetCount, 1);
  assert.equal(assertPackagedReadmeLinks(entries, {
    readmePath: "package/node_modules/open-rfc/README.md",
  }).targetCount, 1);
  assert.throws(
    () => assertPackagedReadmeLinks([], {}),
    /must occur exactly once/u,
  );
  assert.throws(
    () => assertPackagedReadmeLinks([...entries, entries[0]]),
    /must occur exactly once/u,
  );
  assert.throws(
    () => assertPackagedReadmeLinks([
      { path: "package/README.md", bytes: Buffer.from([0xff]) },
    ]),
    /canonical UTF-8/u,
  );
  assert.throws(
    () => assertPackagedReadmeLinks([
      { path: "package/README.md", bytes: Buffer.alloc(512 * 1024 + 1, 0x61) },
    ]),
    /byte envelope/u,
  );
});

test("packaged README HTTPS admission is exact and caller-owned", () => {
  assert.doesNotThrow(() => inspect(`[approved](<${APPROVED}>)\n`, {
    approvedHttpsTargets: [APPROVED],
  }));
  assert.throws(() => inspect(`[changed](<${APPROVED}&extra=1>)\n`, {
    approvedHttpsTargets: [APPROVED],
  }), /explicit allowlist/u);
  assert.throws(() => inspect("[credential](<https://user@example.invalid/>)\n", {
    approvedHttpsTargets: ["https://user@example.invalid/"],
  }), /credential-free/u);
  assert.throws(() => inspect("[anchor](#anchor)\n", {
    approvedHttpsTargets: ["http://example.invalid/"],
  }), /credential-free HTTPS/u);
});
