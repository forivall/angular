/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  AbsoluteSourceSpan,
  AST,
  LetDeclaration,
  ParseSourceSpan,
  PropertyRead,
  R3Identifiers,
  RecursiveAstVisitor,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstBoundText,
  TmplAstComponent,
  TmplAstContent,
  TmplAstDeferredBlock,
  TmplAstDeferredBlockError,
  TmplAstDeferredBlockLoading,
  TmplAstDeferredBlockPlaceholder,
  TmplAstDeferredTrigger,
  TmplAstDirective,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstForLoopBlockEmpty,
  TmplAstIcu,
  TmplAstIfBlock,
  TmplAstIfBlockBranch,
  TmplAstLetDeclaration,
  TmplAstNode,
  TmplAstReference,
  TmplAstSwitchBlock,
  TmplAstSwitchBlockCase,
  TmplAstTemplate,
  TmplAstText,
  TmplAstTextAttribute,
  TmplAstUnknownBlock,
  TmplAstVariable,
  TmplAstVisitor,
} from '@angular/compiler';
import type {
  PotentialDirective,
  TemplateTypeChecker,
} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import {SymbolKind} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import type {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import ts from 'typescript';
import {TypeCheckInfo} from './utils';

/**
 * see https://github.com/microsoft/TypeScript/blob/c85e626d8e17427a6865521737b45ccbbe9c78ef/src/services/classifier2020.ts#L49
 */
export const enum TokenEncodingConsts {
  typeOffset = 8,
  modifierMask = (1 << typeOffset) - 1,
}

/**
 * Token types extended from TypeScript
 * see https://github.com/microsoft/TypeScript/blob/c85e626d8e17427a6865521737b45ccbbe9c78ef/src/services/classifier2020.ts#L55
 */
export const enum TokenType {
  class,
  enum,
  interface,
  namespace,
  typeParameter,
  type,
  parameter,
  variable,
  enumMember,
  property,
  function,
  member,
  signal = 142,
  inputSignal = 143,
}

/**
 * Token modifiers extended from TypeScript
 * see https://github.com/microsoft/TypeScript/blob/c85e626d8e17427a6865521737b45ccbbe9c78ef/src/services/classifier2020.ts#L71
 */
export const enum TokenModifier {
  declaration,
  static,
  async,
  readonly,
  defaultLibrary,
  local,
}

/** @see {@link /packages/compiler-cli/src/ngtsc/typecheck/src/symbol_util} */
const SIGNAL_FNS = new Set([
  'WritableSignal',
  'Signal',
  'InputSignal',
  'InputSignalWithTransform',
  'ModelSignal',
]);

function classifyAs(type: TokenType, modifiers: number = 0) {
  return ((type + 1) << TokenEncodingConsts.typeOffset) + modifiers;
}

// TODO: move these below functions into a class
const classifications = new WeakMap<ts.Symbol | ts.Type, number | null>();
const signalTypeIntersectionItems = new WeakMap<ts.Symbol, ts.IntersectionType>();
function classifyType(tsType: ts.Type, typeChecker: ts.TypeChecker): number | null | undefined {
  if (classifications.has(tsType)) {
    return classifications.get(tsType);
  }
  let typeSymbol = tsType.symbol || tsType.aliasSymbol;
  if (typeSymbol) {
    const classification = classifyTypeSymbolFromAngularCoreOrCache(typeSymbol, typeChecker);
    if (classification != null) {
      classifications.set(tsType, classification);
      return classification;
    }
  }
  if (tsType.isIntersection()) {
    const typeSymbolFromIntersection = getSignalSymbolFromIntersection(tsType);
    if (typeSymbolFromIntersection) {
      const classification = classifyTypeSymbolFromAngularCoreOrCache(
        typeSymbolFromIntersection,
        typeChecker,
      );
      if (classification !== undefined) {
        classifications.set(tsType, classification);
        return classification;
      }
    }
    for (const baseType of tsType.types) {
      const baseClassification = classifyType(baseType, typeChecker);
      if (baseClassification != null) {
        classifications.set(tsType, baseClassification);
        if (typeSymbol) {
          classifications.set(typeSymbol, baseClassification);
        }
        return baseClassification;
      }
    }
  }
  if (tsType.isClassOrInterface()) {
    const baseTypes = typeChecker.getBaseTypes(tsType);
    for (const baseType of baseTypes) {
      const classification = classifyType(baseType, typeChecker);
      if (classification != null) {
        classifications.set(tsType, classification);
        if (typeSymbol) {
          classifications.set(typeSymbol, null);
        }
        return classification;
      }
    }
  }
  classifications.set(tsType, null);
  if (typeSymbol) {
    classifications.set(typeSymbol, null);
  }
  return null;
}
function getSignalSymbolFromIntersection(tsType: ts.IntersectionType) {
  const parentTypes = tsType.types
    .map((baseType) => signalTypeIntersectionItems.get(baseType.symbol))
    .reduce(
      (acc, intersectionType) =>
        intersectionType ? acc.set(intersectionType, (acc.get(intersectionType) ?? 0) + 1) : acc,
      new Map<ts.IntersectionType, number>(),
    );
  for (const [parentType, matchedItems] of parentTypes) {
    if (parentType.types.length === matchedItems) {
      return parentType.symbol || parentType.aliasSymbol;
    }
  }
  // alternatively to this technique, we could look at the source file for the intersection items
  // and walk up the parents of `baseType.symbol.declarations[0]` to find which signal type it's part of.
  return;
}
function classifyTypeSymbolFromAngularCoreOrCache(
  typeSymbol: ts.Symbol,
  typeChecker?: ts.TypeChecker,
): number | null | undefined {
  if (typeChecker && typeSymbol.flags & ts.SymbolFlags.Alias) {
    const aliasSymbol = typeChecker.getAliasedSymbol(typeSymbol);
    return aliasSymbol && classifyTypeSymbolFromAngularCoreOrCache(aliasSymbol);
  }
  if (classifications.has(typeSymbol)) {
    return classifications.get(typeSymbol);
  }
  const signalTypeName = typeSymbol.name;
  if (SIGNAL_FNS.has(signalTypeName)) {
    const declarations = typeSymbol.getDeclarations();
    if (declarations) {
      const isSignalSymbol = declarations.some((decl) => {
        const fileName = decl.getSourceFile().fileName;

        return (
          (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) &&
          SIGNAL_FNS.has(decl.name.text) &&
          (fileName.includes('@angular/core') ||
            fileName.includes('angular2/rc/packages/core') ||
            fileName.includes('bin/packages/core')) // for local usage in some tests
        );
      });
      if (isSignalSymbol) {
        // TODO: warn that signal was not preloaded
        const classification = classifyAs(
          signalTypeName[0] === 'I' ? TokenType.inputSignal : TokenType.signal,
          signalTypeName[0] === 'W' ? 0 : 1 << TokenModifier.readonly,
        );
        classifications.set(typeSymbol, classification);
        return classification;
      }
    }
  }
  return;
}
function getAngularCoreSourceFileSymbol(program: ts.Program, sf?: ts.SourceFile) {
  program.getSemanticDiagnostics;
  let ngCoreImport = sf?.statements.find(
    (s): s is ts.ImportDeclaration =>
      ts.isImportDeclaration(s) &&
      (s.moduleSpecifier as ts.StringLiteral).text === R3Identifiers.core.moduleName,
  );
  if (!ngCoreImport) {
    for (const sf of program.getSourceFiles()) {
      if (program.isSourceFileFromExternalLibrary(sf)) {
        continue;
      }
      ngCoreImport = sf.statements.find(
        (s): s is ts.ImportDeclaration =>
          ts.isImportDeclaration(s) &&
          (s.moduleSpecifier as ts.StringLiteral).text === R3Identifiers.core.moduleName,
      );
      if (ngCoreImport) {
        break;
      }
    }
  }
  if (ngCoreImport) {
    const typeChecker = program.getTypeChecker();
    const tsSymbol = typeChecker.getSymbolAtLocation(ngCoreImport.moduleSpecifier);
    if (tsSymbol) {
      return tsSymbol as ts.Symbol & {valueDeclaration: ts.SourceFile};
    }
  }
  return;
}
function preloadSignalClassifications(program: ts.Program, sf?: ts.SourceFile) {
  const typeChecker = program.getTypeChecker();
  const ngCoreSymbol = getAngularCoreSourceFileSymbol(program, sf);
  if (ngCoreSymbol?.exports) {
    for (const signalTypeName of SIGNAL_FNS) {
      let signalSymbol = ngCoreSymbol.exports.get(signalTypeName as ts.__String);
      if (signalSymbol) {
        if (signalSymbol.flags & ts.SymbolFlags.Alias) {
          signalSymbol = program.getTypeChecker().getAliasedSymbol(signalSymbol);
        }
        classifications.set(
          signalSymbol,
          classifyAs(
            signalTypeName[0] === 'I' ? TokenType.inputSignal : TokenType.signal,
            signalTypeName[0] === 'W' ? 0 : 1 << TokenModifier.readonly,
          ),
        );
        const signalDeclaration = signalSymbol.declarations?.[0];
        const signalType = signalDeclaration && typeChecker?.getTypeAtLocation(signalDeclaration);
        if (signalType?.isIntersection()) {
          for (const intersectionElement of signalType.types) {
            signalTypeIntersectionItems.set(intersectionElement.symbol, signalType);
          }
        }
      } else {
        // TODO: warn that a signal type couldnt be preloaded
      }
    }
  }
}

export function getClassificationsForTypescript(
  compiler: NgCompiler,
  sf: ts.SourceFile,
  range: ts.TextSpan,
): ts.Classifications {
  const program = compiler.getCurrentProgram();
  const typeChecker = program?.getTypeChecker();
  if (!typeChecker) {
    return {spans: [], endOfLineState: ts.EndOfLineState.None};
  }
  preloadSignalClassifications(program, sf);
  const spans: number[] = [];
  let inJSXElement = false;
  function visitTs(node: ts.Node) {
    if (!ts.textSpanIntersectsWith(range, node.getStart(), node.getWidth())) {
      return;
    }
    const prevInJSXElement = inJSXElement;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      inJSXElement = true;
    }
    if (ts.isJsxExpression(node)) {
      inJSXElement = false;
    }

    if (
      ts.isIdentifier(node) &&
      !inJSXElement &&
      !inImportClause(node) &&
      !isInfinityOrNaNString(node.escapedText) &&
      !(
        // This check adds feature parity with webstorm, which doesnt highlight property names in interfaces and object literals
        (
          (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
          node === node.parent.name
        )
      )
    ) {
      let symbol = typeChecker.getSymbolAtLocation(node);
      if (symbol) {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = typeChecker.getAliasedSymbol(symbol);
        }
        const tsType = typeChecker.getTypeOfSymbol(symbol);
        const classification = classifyType(tsType, typeChecker);
        if (classification) {
          spans.push(node.getStart(), node.getWidth(), classification);
        }
      }
    }
    ts.forEachChild(node, visitTs);

    inJSXElement = prevInJSXElement;
  }
  visitTs(sf);
  return {spans, endOfLineState: ts.EndOfLineState.None};
}

export function getClassificationsForTemplate(
  compiler: NgCompiler,
  typeCheckInfo: TypeCheckInfo,
  range: ts.TextSpan,
): ts.Classifications {
  const visitor = new ClassificationVisitor(compiler, typeCheckInfo.declaration, range);
  visitor.visitAll(typeCheckInfo.nodes);

  return {
    spans: visitor.getSpans(),
    endOfLineState: ts.EndOfLineState.None,
  };
}

class ClassificationVisitor implements TmplAstVisitor {
  private spans: number[] = [];
  private tags: Map<string, PotentialDirective | null>;
  private expressionVisitor: TmplExpressionClassificationVisitor;
  private templateTypeChecker: TemplateTypeChecker;
  private tsTypeChecker: ts.TypeChecker;
  constructor(
    compiler: NgCompiler,
    private component: ts.ClassDeclaration,
    private range: ts.TextSpan,
  ) {
    const templateTypeChecker = compiler.getTemplateTypeChecker();
    this.templateTypeChecker = templateTypeChecker;
    this.tsTypeChecker = compiler.getCurrentProgram().getTypeChecker();
    this.tags = templateTypeChecker.getElementsInFileScope(component);
    this.expressionVisitor = new TmplExpressionClassificationVisitor(
      compiler,
      component,
      range,
      this.pushSpan.bind(this),
    );
  }

  getSymbolOfNode(node: TmplAstNode | AST) {
    return this.templateTypeChecker.getSymbolOfNode(node, this.component);
  }

  getSpans(): number[] {
    return this.spans;
  }

  pushSpan(start: number, length: number, classification: number) {
    this.spans.push(start, length, classification);
  }

  visit(node: TmplAstNode | null | undefined) {
    if (node && this.rangeIntersectsWith(node.sourceSpan)) {
      node.visit(this);
    }
  }

  visitElement(element: TmplAstElement) {
    const tag = element.name;
    const potentialDirective = this.tags.get(tag);
    // prevent classification of non-component directives that would be applied
    // to this element due to a matching selector
    const isComponent = potentialDirective && potentialDirective.isComponent;
    const classification = classifyAs(TokenType.class);

    if (isComponent && this.rangeIntersectsWith(element.startSourceSpan)) {
      this.pushSpan(element.startSourceSpan.start.offset + 1, tag.length, classification);
    }

    this.visitAll(element.inputs);
    this.visitAll(element.outputs);
    this.visitAll(element.directives);
    this.visitAll(element.children);

    if (isComponent && !element.isSelfClosing && this.rangeIntersectsWith(element.endSourceSpan!)) {
      this.pushSpan(element.endSourceSpan!.start.offset + 2, tag.length, classification);
    }
  }

  visitContent(content: TmplAstContent) {
    this.visitAll(content.children);
  }

  visitVariable(variable: TmplAstVariable) {
    const ngSymbol = this.getSymbolOfNode(variable);

    if (ngSymbol?.kind === SymbolKind.Variable) {
      const classification = classifyType(ngSymbol.tsType, this.tsTypeChecker);
      if (classification) {
        this.pushSpan(variable.keySpan.start.offset + 4, variable.name.length, classification);
        if (variable.valueSpan) {
          const {
            start: {offset: startOffset},
            end,
          } = variable.valueSpan;
          this.pushSpan(startOffset, end.offset - startOffset, classification);
        }
      }
    }
  }
  visitReference(reference: TmplAstReference) {}
  visitTextAttribute(attribute: TmplAstTextAttribute) {}
  visitBoundAttribute(attribute: TmplAstBoundAttribute) {
    this.expressionVisitor.visit(attribute.value, attribute);
  }
  visitBoundEvent(attribute: TmplAstBoundEvent) {
    this.expressionVisitor.visit(attribute.handler, attribute);
  }
  visitText(text: TmplAstText) {}
  visitBoundText(text: TmplAstBoundText) {
    this.expressionVisitor.visit(text.value, text);
  }
  visitIcu(icu: TmplAstIcu) {}

  visitDeferredBlock(deferred: TmplAstDeferredBlock) {
    this.visit(deferred.hydrateTriggers.when);
    this.visit(deferred.triggers.when);
    this.visit(deferred.prefetchTriggers.when);
    this.visitAll(deferred.children);
    this.visit(deferred.error);
    this.visit(deferred.loading);
    this.visit(deferred.placeholder);
  }

  visitDeferredBlockPlaceholder(block: TmplAstDeferredBlockPlaceholder) {
    this.visitAll(block.children);
  }

  visitDeferredBlockError(block: TmplAstDeferredBlockError) {
    this.visitAll(block.children);
  }

  visitDeferredBlockLoading(block: TmplAstDeferredBlockLoading) {
    this.visitAll(block.children);
  }

  visitDeferredTrigger(trigger: TmplAstDeferredTrigger) {}

  visitSwitchBlock(block: TmplAstSwitchBlock) {
    this.expressionVisitor.visit(block.expression, block);
    this.visitAll(block.cases);
  }

  visitSwitchBlockCase(block: TmplAstSwitchBlockCase) {
    this.visitAll(block.children);
  }

  visitForLoopBlock(block: TmplAstForLoopBlock) {
    this.expressionVisitor.visit(block.expression, block);
    this.expressionVisitor.visit(block.trackBy, block);
    this.visit(block.item);
    this.visitAll(block.contextVariables);
    this.visitAll(block.children);
    this.visit(block.empty);
  }

  visitForLoopBlockEmpty(block: TmplAstForLoopBlockEmpty) {
    this.visitAll(block.children);
  }

  visitIfBlock(block: TmplAstIfBlock) {
    this.visitAll(block.branches);
  }

  visitIfBlockBranch(block: TmplAstIfBlockBranch) {
    this.visitAll(block.children);
    // TODO: visit .expressionAlias if variables have symbol type
    debugger;
  }

  visitTemplate(template: TmplAstTemplate) {
    this.visitAll(template.inputs);
    this.visitAll(template.outputs);
    this.visitAll(template.directives);
    this.visitAll(template.children);
    // TODO: visit variables if we can get the symbol type of the variable
    debugger;
  }

  visitUnknownBlock(block: TmplAstUnknownBlock) {}
  visitLetDeclaration(decl: TmplAstLetDeclaration) {
    const ngSymbol = this.getSymbolOfNode(decl);
    if (ngSymbol?.kind === SymbolKind.LetDeclaration) {
      const classification = classifyType(ngSymbol.tsType, this.tsTypeChecker);
      if (classification) {
        this.pushSpan(decl.nameSpan.start.offset, decl.name.length, classification);
      }
    }
    this.expressionVisitor.visit(decl.value, decl);
  }

  visitComponent(component: TmplAstComponent) {
    this.visitAll(component.inputs);
    this.visitAll(component.outputs);
    this.visitAll(component.directives);
    this.visitAll(component.children);
  }
  visitDirective(directive: TmplAstDirective) {
    this.visitAll(directive.inputs);
    this.visitAll(directive.outputs);
  }

  visitAll(children: TmplAstNode[]) {
    for (const child of children) {
      this.visit(child);
    }
  }

  private rangeIntersectsWith(span: ParseSourceSpan) {
    const start = span.start.offset;
    const length = span.end.offset - start;
    return ts.textSpanIntersectsWith(this.range, start, length);
  }
}

class TmplExpressionClassificationVisitor extends RecursiveAstVisitor {
  private templateTypeChecker: TemplateTypeChecker;
  private tsTypeChecker: ts.TypeChecker;
  constructor(
    compiler: NgCompiler,
    private component: ts.ClassDeclaration,
    private range: ts.TextSpan,
    private pushSpan: (start: number, length: number, classification: number) => void,
  ) {
    super();
    this.templateTypeChecker = compiler.getTemplateTypeChecker();
    this.tsTypeChecker = compiler.getCurrentProgram().getTypeChecker();
  }

  getSymbolOfNode(node: TmplAstNode | AST) {
    return this.templateTypeChecker.getSymbolOfNode(node, this.component);
  }

  override visit(ast: AST, context?: any) {
    if (ast && this.rangeIntersectsWith(ast.sourceSpan)) {
      ast.visit(this);
    }
  }

  override visitPropertyRead(ast: PropertyRead, context: TmplAstNode) {
    const ngSymbol = this.getSymbolOfNode(ast);
    if (ngSymbol?.kind === SymbolKind.Expression) {
      const classification = classifyType(ngSymbol.tsType, this.tsTypeChecker);
      if (classification) {
        this.pushClassification(ast.nameSpan, classification);
      }
    }
    super.visitPropertyRead(ast, context);
  }

  private pushClassification(span: AbsoluteSourceSpan, classification: number) {
    const start = span.start;
    const length = span.end - start;
    this.pushSpan(start, length, classification);
  }

  private rangeIntersectsWith(span: AbsoluteSourceSpan) {
    const start = span.start;
    const length = span.end - start;
    return ts.textSpanIntersectsWith(this.range, start, length);
  }
  // alternative to `.kind` checking:
  // type UnionKey<T> = T extends never ? never : keyof T;
  // type ExtractWithKey<T, K extends UnionKey<T>> = T extends {[_ in K]?: unknown}
  //   ? T
  //   : T & {[_ in K]?: never};
  // const tsSymbol = (ngSymbol as ExtractWithKey<typeof ngSymbol, 'tsSymbol'>).tsSymbol;
  // const tsType = (ngSymbol as ExtractWithKey<typeof ngSymbol, 'tsType'>).tsType;
}

export function inImportClause(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent &&
    (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent))
  );
}
export function isInfinityOrNaNString(name: string | ts.__String): boolean {
  return name === 'Infinity' || name === '-Infinity' || name === 'NaN';
}
