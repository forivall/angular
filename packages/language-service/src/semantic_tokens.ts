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
  ASTWithName,
  ParseSourceSpan,
  PropertyRead,
  R3Identifiers,
  RecursiveAstVisitor,
  SafePropertyRead,
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

export class TsTypeClassifier {
  tsTypeChecker: ts.TypeChecker;
  classifications = new WeakMap<ts.Symbol | ts.Type, number | null>();
  signalTypeIntersectionItems = new WeakMap<ts.Symbol, ts.IntersectionType>();
  constructor(
    private program: ts.Program,
    private logger?: ts.server.Logger,
  ) {
    this.tsTypeChecker = program.getTypeChecker();
    this.preloadSignalClassifications();
  }
  classifyIdentifier(node: ts.Identifier) {
    let symbol = this.tsTypeChecker.getSymbolAtLocation(node);
    if (symbol) {
      if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = this.tsTypeChecker.getAliasedSymbol(symbol);
      }
      const tsType = this.tsTypeChecker.getTypeOfSymbol(symbol);
      return this.classifyType(tsType);
    }
    return;
  }
  classifyType(tsType: ts.Type): number | null | undefined {
    if (this.classifications.has(tsType)) {
      return this.classifications.get(tsType);
    }
    if (tsType.isUnion()) {
      const nonNull = tsType.getNonNullableType();
      if (nonNull !== tsType) {
        const classification = this.classifyType(nonNull);
        if (classification !== undefined) {
          this.classifications.set(tsType, classification);
          return classification;
        }
      }
    }
    let typeSymbol = tsType.symbol || tsType.aliasSymbol;
    if (typeSymbol) {
      const classification = this.classifyTypeSymbolFromAngularCoreOrCache(typeSymbol);
      if (classification != null) {
        this.classifications.set(tsType, classification);
        return classification;
      }
    }
    if (tsType.isIntersection()) {
      const typeSymbolFromIntersection = this.getSignalSymbolFromIntersection(tsType);
      if (typeSymbolFromIntersection) {
        const classification = this.classifyTypeSymbolFromAngularCoreOrCache(
          typeSymbolFromIntersection,
        );
        if (classification !== undefined) {
          this.classifications.set(tsType, classification);
          return classification;
        }
      }
      for (const baseType of tsType.types) {
        const baseClassification = this.classifyType(baseType);
        if (baseClassification != null) {
          this.classifications.set(tsType, baseClassification);
          if (typeSymbol) {
            this.classifications.set(typeSymbol, baseClassification);
          }
          return baseClassification;
        }
      }
    }
    if (tsType.isClassOrInterface()) {
      const baseTypes = this.tsTypeChecker.getBaseTypes(tsType);
      for (const baseType of baseTypes) {
        const classification = this.classifyType(baseType);
        if (classification != null) {
          this.classifications.set(tsType, classification);
          if (typeSymbol) {
            this.classifications.set(typeSymbol, null);
          }
          return classification;
        }
      }
    }
    this.classifications.set(tsType, null);
    if (typeSymbol) {
      this.classifications.set(typeSymbol, null);
    }
    return null;
  }
  private getSignalSymbolFromIntersection(tsType: ts.IntersectionType) {
    const parentTypes = tsType.types
      .map((baseType) => this.signalTypeIntersectionItems.get(baseType.symbol))
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
  private classifyTypeSymbolFromAngularCoreOrCache(
    typeSymbol: ts.Symbol,
  ): number | null | undefined {
    if (typeSymbol.flags & ts.SymbolFlags.Alias) {
      const aliasSymbol = this.tsTypeChecker.getAliasedSymbol(typeSymbol);
      return aliasSymbol && this.classifyTypeSymbolFromAngularCoreOrCache(aliasSymbol);
    }
    if (this.classifications.has(typeSymbol)) {
      return this.classifications.get(typeSymbol);
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
          this.classifications.set(typeSymbol, classification);
          return classification;
        }
      }
    }
    return;
  }
  private getAngularCoreSourceFileSymbol(sf?: ts.SourceFile) {
    let ngCoreImport = sf?.statements.find(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        (s.moduleSpecifier as ts.StringLiteral).text === R3Identifiers.core.moduleName,
    );
    if (!ngCoreImport) {
      for (const sf of this.program.getSourceFiles()) {
        if (this.program.isSourceFileFromExternalLibrary(sf)) {
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
      const typeChecker = this.program.getTypeChecker();
      const tsSymbol = typeChecker.getSymbolAtLocation(ngCoreImport.moduleSpecifier);
      if (tsSymbol) {
        return tsSymbol as ts.Symbol & {valueDeclaration: ts.SourceFile};
      }
    }
    return;
  }
  private preloadSignalClassifications(sf?: ts.SourceFile) {
    const ngCoreSymbol = this.getAngularCoreSourceFileSymbol(sf);
    if (ngCoreSymbol?.exports) {
      for (const signalTypeName of SIGNAL_FNS) {
        let signalSymbol = ngCoreSymbol.exports.get(signalTypeName as ts.__String);
        if (signalSymbol) {
          if (signalSymbol.flags & ts.SymbolFlags.Alias) {
            signalSymbol = this.tsTypeChecker.getAliasedSymbol(signalSymbol);
          }
          this.classifications.set(
            signalSymbol,
            classifyAs(
              signalTypeName[0] === 'I' ? TokenType.inputSignal : TokenType.signal,
              signalTypeName[0] === 'W' ? 0 : 1 << TokenModifier.readonly,
            ),
          );
          const signalDeclaration = signalSymbol.declarations?.[0];
          const signalType =
            signalDeclaration && this.tsTypeChecker.getTypeAtLocation(signalDeclaration);
          if (signalType?.isIntersection()) {
            for (const intersectionElement of signalType.types) {
              this.signalTypeIntersectionItems.set(intersectionElement.symbol, signalType);
            }
          }
        } else {
          this.logger?.info(`NgLS: failed to load ${signalTypeName}`);
        }
      }
    }
  }
}

export function getClassificationsForTypescript(
  typeClassifier: TsTypeClassifier,
  sf: ts.SourceFile,
  range: ts.TextSpan,
): ts.Classifications {
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

    function inImportClause(node: ts.Node): boolean {
      const parent = node.parent;
      return (
        parent &&
        (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent))
      );
    }
    function isInfinityOrNaNString(name: string | ts.__String): boolean {
      return name === 'Infinity' || name === '-Infinity' || name === 'NaN';
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
      const classification = typeClassifier.classifyIdentifier(node);
      if (classification) {
        spans.push(node.getStart(), node.getWidth(), classification);
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
  tsTypeClassifier: TsTypeClassifier,
  range: ts.TextSpan,
): ts.Classifications {
  const templateTypeChecker = compiler.getTemplateTypeChecker();

  const visitor = new ClassificationVisitor(
    templateTypeChecker,
    tsTypeClassifier,
    typeCheckInfo.declaration,
    range,
  );
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
  constructor(
    private templateTypeChecker: TemplateTypeChecker,
    private typeClassifier: TsTypeClassifier,
    private component: ts.ClassDeclaration,
    private range: ts.TextSpan,
  ) {
    this.tags = templateTypeChecker.getElementsInFileScope(component);
    this.expressionVisitor = new TmplExpressionClassificationVisitor(
      templateTypeChecker,
      typeClassifier,
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
      const classification = this.typeClassifier.classifyType(ngSymbol.tsType);
      if (classification) {
        this.pushSpan(variable.keySpan.start.offset, variable.name.length, classification);
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
    if (block.expression) {
      this.expressionVisitor.visit(block.expression, block);
    }
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
    if (block.expression) {
      this.expressionVisitor.visit(block.expression, block);
      if (block.expressionAlias) {
        const symbol = this.getSymbolOfNode(block.expressionAlias);
        switch (symbol?.kind) {
          case SymbolKind.Variable:
          case SymbolKind.Expression:
            const classification = this.typeClassifier.classifyType(symbol.tsType);
            if (classification) {
              this.pushSpan(
                block.expressionAlias.keySpan.start.offset,
                block.expressionAlias.name.length,
                classification,
              );
            }
        }
      }
    }
    this.visitAll(block.children);
  }

  visitTemplate(template: TmplAstTemplate) {
    this.visitAll(template.variables);
    this.visitAll(template.inputs);
    this.visitAll(template.outputs);
    this.visitAll(template.directives);
    this.visitAll(template.children);
  }

  visitUnknownBlock(block: TmplAstUnknownBlock) {}
  visitLetDeclaration(decl: TmplAstLetDeclaration) {
    const ngSymbol = this.getSymbolOfNode(decl);
    if (ngSymbol?.kind === SymbolKind.LetDeclaration) {
      const classification = this.typeClassifier.classifyType(ngSymbol.tsType);
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
  constructor(
    private templateTypeChecker: TemplateTypeChecker,
    private typeClassifier: TsTypeClassifier,
    private component: ts.ClassDeclaration,
    private range: ts.TextSpan,
    private pushSpan: (start: number, length: number, classification: number) => void,
  ) {
    super();
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
    this.classifyASTWithName(ast);
    super.visitPropertyRead(ast, context);
  }

  override visitSafePropertyRead(ast: SafePropertyRead, context: any) {
    this.classifyASTWithName(ast);
    super.visitSafePropertyRead(ast, context);
  }

  private classifyASTWithName(ast: ASTWithName) {
    const ngSymbol = this.getSymbolOfNode(ast);
    switch (ngSymbol?.kind) {
      case SymbolKind.Variable:
      case SymbolKind.Expression:
        const classification = this.typeClassifier.classifyType(ngSymbol.tsType);
        if (classification) {
          this.pushClassification(ast.nameSpan, classification);
        }
    }
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
