import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { getLanguageForFile, parseSource } from "../../src/graph/parser.js";

describe("Rust support", () => {
  describe("parser", () => {
    it("maps .rs extension to rust", () => {
      expect(getLanguageForFile("lib.rs")).toBe("rust");
      expect(getLanguageForFile("src/main.rs")).toBe("rust");
    });

    it("parses Rust source natively (sync)", () => {
      const tree = parseSource("fn main() {}", "main.rs");
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("source_file");
    });
  });

  describe("extractor", () => {
    it("extracts free functions with signatures", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
pub fn add(a: i32, b: i32) -> i32 { a + b }

fn helper(x: i32) -> i32 { x }
`,
      }]);

      const add = graph.defines.find((d) => d.name === "add");
      const helper = graph.defines.find((d) => d.name === "helper");
      expect(add).toBeDefined();
      expect(add?.kind).toBe("function");
      expect(add?.signature).toBe("(a: i32, b: i32) -> i32");
      expect(helper).toBeDefined();
    });

    it("marks pub items as exported, private items as not", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
pub fn public_fn() {}
fn private_fn() {}
pub struct Point { x: f64 }
struct Hidden {}
`,
      }]);

      const exports = graph.exports.map((e) => e.name);
      expect(exports).toContain("public_fn");
      expect(exports).toContain("Point");
      expect(exports).not.toContain("private_fn");
      expect(exports).not.toContain("Hidden");
    });

    it("extracts structs, enums as classes and traits as interfaces", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
pub struct Point { x: f64, y: f64 }
pub enum Color { Red, Green }
pub trait Shape { fn area(&self) -> f64; }
`,
      }]);

      const point = graph.defines.find((d) => d.name === "Point");
      const color = graph.defines.find((d) => d.name === "Color");
      const shape = graph.defines.find((d) => d.name === "Shape");
      expect(point?.kind).toBe("class");
      expect(color?.kind).toBe("class");
      expect(shape?.kind).toBe("interface");
    });

    it("attaches impl methods to their type via contains", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
pub struct Point { x: f64, y: f64 }

impl Point {
    pub fn area(&self) -> f64 { self.x.hypot(self.y) }
}
`,
      }]);

      const area = graph.defines.find((d) => d.name === "area");
      expect(area?.kind).toBe("method");
      expect(graph.contains).toContainEqual({ parent: "Point", child: "area" });
    });

    it("extracts call edges (plain, method, and associated calls)", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
fn helper(x: i32) -> i32 { x }

pub fn run() {
    helper(1);
    Builder::new();
    obj.process();
}
`,
      }]);

      const calls = graph.calls.filter((c) => c.caller === "run").map((c) => c.callee);
      expect(calls).toContain("helper");
      expect(calls).toContain("new");
      expect(calls).toContain("process");
    });

    it("extracts use declarations as imports", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
use std::collections::HashMap;
use crate::utils::{foo, bar};
`,
      }]);

      const names = graph.imports.map((i) => i.name);
      expect(names).toContain("HashMap");
      expect(names).toContain("foo");
      expect(names).toContain("bar");
    });

    it("binds renamed imports to their alias", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `use std::io::Result as IoResult;\n`,
      }]);

      const names = graph.imports.map((i) => i.name);
      expect(names).toContain("IoResult");
      expect(names).not.toContain("Result");
    });

    it("recurses into modules", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `
pub mod geometry {
    pub fn distance() -> f64 { 0.0 }
}
`,
      }]);

      const dist = graph.defines.find((d) => d.name === "distance");
      expect(dist).toBeDefined();
      expect(dist?.kind).toBe("function");
    });

    it("captures /// doc comments as the file doc", async () => {
      const graph = await extractGraph([{
        path: "lib.rs",
        content: `//! Geometry utilities for 2D points.

pub fn area() -> f64 { 0.0 }
`,
      }]);

      const file = graph.files?.find((f) => f.path === "lib.rs");
      expect(file?.language).toBe("rust");
      expect(file?.fileDoc).toContain("Geometry utilities");
    });
  });
});
