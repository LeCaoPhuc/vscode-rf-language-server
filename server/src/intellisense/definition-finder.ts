import * as _ from "lodash";
import Workspace from "./workspace/workspace";
import {
  Node,
  CallExpression,
  VariableExpression,
  VariableDeclaration,
  UserKeyword,
  TestSuite,
} from "../parser/models";
import { ConsoleLogger } from "../logger";
import { traverse, VisitorOption } from "../traverse/traverse";
import { Location } from "../utils/position";
import { identifierMatchesKeyword } from "./keyword-matcher";
import { FileNode, findNodeInPos } from "./node-locator";
import { nodeLocationToRange } from "../utils/position";
import {
  isIdentifier,
  isVariableExpression,
  isCallExpression,
  isVariableDeclaration,
  isFunctionDeclaration,
  isUserKeyword,
  isNamespacedIdentifier,
} from "./type-guards";

import { Range } from "./models";

const logger = ConsoleLogger;

export interface NodeDefinition {
  node: Node;
  uri: string;
  range: Range;
}

export interface KeywordDefinition {
  node: UserKeyword;
  uri: string;
  range: Range;
}

export interface VariableDefinition {
  node: VariableDeclaration;
  uri: string;
  range: Range;
}

export function findDefinition(
  location: Location,
  workspaceTree: Workspace
): NodeDefinition {
  const file = workspaceTree.getFile(location.filePath);
  if (!file) {
    logger.info(`Definition not found. File '${location.filePath}' not parsed`);
    return null;
  }

  const nodeInPos = findNodeInPos(location.position, file);
  if (!isIdentifier(nodeInPos.node)) {
    const logMsg =
      "Definition not found. " +
      `Node in position is not an identifier, but of type ${
        nodeInPos.node.type
      }`;
    logger.info(logMsg);
    return null;
  }

  const parentOfNode = _.last(nodeInPos.path);
  let foundDefinition = null;
  if (isVariableExpression(parentOfNode)) {
    logger.info(
      "Parent is a variable expression, finding a variable definition"
    );
    foundDefinition = findVariableDefinition(
      parentOfNode,
      nodeInPos,
      workspaceTree
    );
  } else if (isCallExpression(parentOfNode)) {
    logger.info("Parent is a call expression, finding a keyword definition");
    foundDefinition = findKeywordDefinition(
      parentOfNode,
      nodeInPos,
      workspaceTree
    );
  } else {
    logger.info(
      `Parent is of type ${parentOfNode.type}. No definition available`
    );
  }

  return foundDefinition;
}

export function findVariableDefinition(
  variable: VariableExpression,
  variableLocation: FileNode,
  workspaceTree: Workspace
): VariableDefinition {
  let foundVariableDefinition = tryFindVarDefStartingFromNode(
    variable,
    variableLocation
  );

  if (foundVariableDefinition) {
    return {
      node: foundVariableDefinition,
      uri: variableLocation.file.uri,
      range: nodeLocationToRange(foundVariableDefinition),
    };
  }

  // TODO: iterate in import order
  for (const file of workspaceTree.getFiles()) {
    foundVariableDefinition = findVariableDefinitionFromFile(
      variable,
      file.ast
    );
    if (foundVariableDefinition) {
      return {
        node: foundVariableDefinition,
        uri: file.uri,
        range: nodeLocationToRange(foundVariableDefinition),
      };
    }
  }

  logger.info("Variable definition not found from the workspace");
  return null;
}

export function findKeywordDefinition(
  callExpression: CallExpression,
  keywordLocation: FileNode,
  workspaceTree: Workspace
): KeywordDefinition {
  let foundDefinition = findKeywordDefinitionFromFile(
    callExpression,
    keywordLocation.file.ast
  );
  if (foundDefinition) {
    return {
      node: foundDefinition,
      uri: keywordLocation.file.uri,
      range: nodeLocationToRange(foundDefinition),
    };
  }

  const identifier = callExpression.callee;
  if (isNamespacedIdentifier(identifier)) {
    const file = workspaceTree.getFileByNamespace(identifier.namespace);
    if (!!file) {
      logger.info(`Found matching file by namespace ${identifier.namespace}`);

      foundDefinition = findKeywordDefinitionFromFile(callExpression, file.ast);
      if (foundDefinition) {
        logger.info("Found matching keyword by namespace");

        return {
          node: foundDefinition,
          uri: file.uri,
          range: nodeLocationToRange(foundDefinition),
        };
      } else {
        logger.info(`No keyword found from file`);
      }
    } else {
      logger.info(
        `No matching file found for namespace ${identifier.namespace}`
      );
    }
  }

  // TODO: iterate in import order
  for (const file of workspaceTree.getFiles()) {
    if (file.filePath === keywordLocation.file.filePath) {
      continue;
    }

    foundDefinition = findKeywordDefinitionFromFile(callExpression, file.ast);
    if (foundDefinition) {
      return {
        node: foundDefinition,
        uri: file.uri,
        range: nodeLocationToRange(foundDefinition),
      };
    }
  }

  logger.info("Keyword definition not found from the workspace");
  return null;
}

function tryFindVarDefStartingFromNode(
  variable: VariableExpression,
  location: FileNode
): VariableDeclaration {
  let foundVariableDefinition = null;

  _.reverse(location.path).find(node => {
    if (!isFunctionDeclaration(node)) {
      return false;
    }

    // Try to find from steps
    const foundInSteps =
      node.steps.find(nodeInStep => {
        const { body } = nodeInStep;

        if (
          isVariableDeclaration(body) &&
          body.kind === variable.kind &&
          body.id.name === variable.id.name
        ) {
          foundVariableDefinition = body;
          return true;
        } else {
          return false;
        }
      }) !== undefined;

    if (foundInSteps) {
      return true;
    }

    if (!isUserKeyword(node) || !node.arguments) {
      return false;
    }

    // Try to find from keyword arguments
    return (
      node.arguments.values.find(arg => {
        if (arg.kind === variable.kind && arg.id.name === variable.id.name) {
          foundVariableDefinition = arg;
          return true;
        } else {
          return false;
        }
      }) !== undefined
    );
  });

  if (foundVariableDefinition) {
    return foundVariableDefinition;
  }

  if (location.file.ast.variablesTable) {
    location.file.ast.variablesTable.variables.find(varTableVar => {
      if (
        varTableVar.kind === variable.kind &&
        varTableVar.id.name === variable.id.name
      ) {
        foundVariableDefinition = varTableVar;
        return true;
      } else {
        return false;
      }
    });
  }

  return foundVariableDefinition;
}

function findVariableDefinitionFromFile(
  variable: VariableExpression,
  file: TestSuite
): VariableDeclaration {
  const nodesToEnter = new Set(["TestSuite", "VariablesTable"]);

  let foundVariable = null;
  const isNodeSearchedVar = node =>
    isVariableDeclaration(node) &&
    node.kind === variable.kind &&
    node.id.name === variable.id.name;

  traverse(file, {
    enter: (node: Node, parent: Node) => {
      if (isNodeSearchedVar(node)) {
        foundVariable = node;

        return VisitorOption.Break;
      } else if (!nodesToEnter.has(node.type)) {
        return VisitorOption.Skip;
      }
    },
  });

  return foundVariable;
}

function findKeywordDefinitionFromFile(
  callExpression: CallExpression,
  file: TestSuite
): UserKeyword {
  const nodesToEnter = new Set(["TestSuite", "KeywordsTable"]);

  let foundKeyword = null;
  const isNodeSearchedKeyword = node =>
    isUserKeyword(node) &&
    identifierMatchesKeyword(callExpression.callee, node);

  traverse(file, {
    enter: (node: Node, parent: Node) => {
      if (isNodeSearchedKeyword(node)) {
        foundKeyword = node;

        return VisitorOption.Break;
      } else if (!nodesToEnter.has(node.type)) {
        return VisitorOption.Skip;
      }
    },
  });

  return foundKeyword;
}
