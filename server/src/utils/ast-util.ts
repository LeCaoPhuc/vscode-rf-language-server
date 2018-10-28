import { Node } from "../parser/models";
import { traverse } from "../traverse/traverse";

/**
 * Traverses given abstract syntax tree and returns the nodes
 * for which the matchFn returns a truthy value.
 *
 * @param ast  abstract syntax tree
 * @param matchFn
 */
export function filter(ast: Node, matchFn: ((node: Node) => boolean)) {
  const nodes = [];

  traverse(ast, {
    enter: (node: Node) => {
      if (matchFn(node)) {
        nodes.push(node);
      }
    },
  });

  return nodes;
}
