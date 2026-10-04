import { describe, it, expect } from "vitest";
import {
  listIdentities,
  findIdentity,
  identityForEmail,
  primaryIdentity,
} from "../src/identities";
import type { Env } from "../src/types";

const env = (extra?: string) =>
  ({
    PRIMARY_ADDRESS: "amir@devartslab.com",
    DISPLAY_NAME: "Amir | DevArts Lab",
    EXTRA_IDENTITIES: extra || "",
  }) as Env;

describe("listIdentities", () => {
  it("returns primary only when no extras", () => {
    expect(listIdentities(env())).toEqual([
      { address: "amir@devartslab.com", name: "Amir | DevArts Lab" },
    ]);
  });

  it("parses addr=Name pairs separated by semicolons", () => {
    const ids = listIdentities(
      env("pypi@devartslab.com=PyPI | DevArts Lab; bots@devartslab.com"),
    );
    expect(ids).toEqual([
      { address: "amir@devartslab.com", name: "Amir | DevArts Lab" },
      { address: "pypi@devartslab.com", name: "PyPI | DevArts Lab" },
      { address: "bots@devartslab.com", name: "bots@devartslab.com" },
    ]);
  });

  it("lowercases, trims, dedupes, skips empties", () => {
    const ids = listIdentities(
      env(" PyPI@DevArtsLab.com =PyPI;amir@devartslab.com=Dup;; =bad"),
    );
    expect(ids.map((i) => i.address)).toEqual([
      "amir@devartslab.com",
      "pypi@devartslab.com",
    ]);
    expect(ids[1].name).toBe("PyPI");
  });
});

describe("findIdentity", () => {
  it("matches case-insensitively", () => {
    expect(
      findIdentity(env("pypi@devartslab.com=PyPI"), "PYPI@devartslab.com")?.name,
    ).toBe("PyPI");
    expect(findIdentity(env(), "nope@devartslab.com")).toBeNull();
    expect(findIdentity(env(), undefined)).toBeNull();
  });
});

describe("identityForEmail", () => {
  it("finds the invited identity in to or cc", () => {
    const e = env("pypi@devartslab.com=PyPI");
    const mail = (to: string[], cc: string[] = []) => ({
      to_addresses: JSON.stringify(to),
      cc_addresses: JSON.stringify(cc),
    });
    expect(identityForEmail(e, mail(["pypi@devartslab.com"]))?.name).toBe("PyPI");
    expect(
      identityForEmail(e, mail(["other@x.com"], ["amir@devartslab.com"]))?.address,
    ).toBe("amir@devartslab.com");
    expect(identityForEmail(e, mail(["other@x.com"]))).toBeNull();
    expect(
      identityForEmail(e, { to_addresses: "bad json", cc_addresses: "[]" }),
    ).toBeNull();
  });
});

describe("primaryIdentity", () => {
  it("is always the first identity", () => {
    expect(primaryIdentity(env("pypi@devartslab.com=X")).address).toBe(
      "amir@devartslab.com",
    );
  });
});
