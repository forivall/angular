import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import ts from 'typescript';
import {getFirstComponentForTemplateFile, isTypeScriptFile} from './utils';
import {
  ParseSourceSpan,
  TmplAstBlockNode,
  TmplAstForLoopBlock,
  TmplAstLetDeclaration,
  TmplAstNode,
  TmplAstRecursiveVisitor,
  tmplAstVisitAll,
  RecursiveAstVisitor,
  PropertyRead as PropertyRead,
  TmplAstBoundEvent,
  TmplAstBoundAttribute,
  TmplAstBoundText,
  TmplAstSwitchBlock,
} from '@angular/compiler';
import {isNamedClassDeclaration} from '@angular/compiler-cli/src/ngtsc/reflection';
import {isExternalResource} from '@angular/compiler-cli/src/ngtsc/metadata';
import {TemplateTypeChecker} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
export type AddSignalSpan = (
  start: number,
  length: number,
  isReadonly: boolean,
  isInput: boolean,
) => void;
export type OnSignal = (isReadonly: boolean, isInput: boolean) => void;

export function getSemanticClassificationsImpl(
  compiler: NgCompiler,
  fileName: string,
  span: ts.TextSpan,
  addSignalSpan: AddSignalSpan,
): void {
  const program = compiler.getCurrentProgram();
  if (!program) {
    return;
  }
  let sourceFile: ts.SourceFile | undefined;

  sourceFile = program?.getSourceFile(fileName);

  const typeChecker = program.getTypeChecker();

  let inJSXElement = false;
  function visitTs(node: ts.Node) {
    if (!textSpanIntersectsWithNode(span, node)) {
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
      !isInfinityOrNaNString(node.escapedText)
    ) {
      let symbol = typeChecker.getSymbolAtLocation(node);
      if (symbol) {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = typeChecker.getAliasedSymbol(symbol);
        }
        const tsType = typeChecker.getTypeOfSymbol(symbol);
        collectSignal(tsType, symbol, (isReadonly, isInput) =>
          addSignalSpan(node.getStart(), node.getWidth(), isReadonly, isInput),
        );
      }
    }
    ts.forEachChild(node, visitTs);

    inJSXElement = prevInJSXElement;
  }

  if (isTypeScriptFile(fileName)) {
    sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      return;
    }
    visitTs(sourceFile);

    for (const stmt of sourceFile.statements) {
      if (!textSpanIntersectsWithNode(span, stmt) || !isNamedClassDeclaration(stmt)) {
        continue;
      }
      const resources = compiler.getDirectiveResources(stmt);
      if (
        resources === null ||
        resources.template === null ||
        isExternalResource(resources.template)
      ) {
        continue;
      }
      const templateTypeChecker = compiler.getTemplateTypeChecker();
      const template = templateTypeChecker.getTemplate(stmt);
      if (template === null) {
        continue;
      }
      TemplateSemanticClassifierVisitor.collectSignalSpans(
        template,
        typeChecker,
        templateTypeChecker,
        stmt,
        span,
        addSignalSpan,
        sourceFile,
      );
    }
  } else {
    const typeCheckInfo = getFirstComponentForTemplateFile(fileName, compiler);
    if (typeCheckInfo) {
      TemplateSemanticClassifierVisitor.collectSignalSpans(
        typeCheckInfo.nodes,
        typeChecker,
        compiler.getTemplateTypeChecker(),
        typeCheckInfo.declaration,
        span,
        addSignalSpan,
        sourceFile,
      );
    }
  }
}

function textSpanIntersectsWithNode(span: ts.TextSpan, node: ts.Node) {
  const nodeFullWidth = node?.getFullWidth();
  return nodeFullWidth && ts.textSpanIntersectsWith(span, node.pos, nodeFullWidth);
}

function textSpanIntersectsWithParseSpan(span: ts.TextSpan, parseSpan: ParseSourceSpan) {
  const start = parseSpan.start.offset;
  const length = parseSpan.end.offset - start;
  return length && ts.textSpanIntersectsWith(span, start, length);
}

function collectSignal(
  tsType: ts.Type,
  tsSymbol: ts.Symbol,
  onSignal: (isReadonly: boolean, isInput: boolean) => void,
) {
  const typeSymbol = tsType.symbol;
  if (!typeSymbol) {
    return;
  }
  const typeName = typeSymbol.name;
  let isSignalTypeName = false;
  let isInput = false;
  let isReadonly = false;
  switch (typeName) {
    //@ts-expect-error fallthrough
    case 'InputSignal':
      isInput = true;
    //@ts-expect-error fallthrough
    case 'Signal':
      isReadonly = true;
    case 'WritableSignal':
      isSignalTypeName = true;
  }
  if (isSignalTypeName) {
    const isAngularCoreSignal = typeSymbol.declarations?.some((decl) =>
      /\/@angular\/core\//.test(decl.getSourceFile().fileName),
    );
    if (isAngularCoreSignal) {
      onSignal(isReadonly, isInput);
      return;
    }
  }

  if (tsSymbol.flags & ts.SymbolFlags.Property) {
    const decl = tsSymbol.valueDeclaration;
    if (decl) {
      const declType = (decl as ts.HasType).type;
      if (declType) {
        const declText = declType.getText();
        if (/\bWritableSignal\b/.test(declText)) {
          onSignal(false, false);
        } else if (/\bSignal\b/.test(declText)) {
          onSignal(true, false);
        }
        return;
      }
      if (
        ts.hasOnlyExpressionInitializer(decl) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer)
      ) {
        const declExpression = decl.initializer.expression;
        if (ts.isIdentifier(declExpression)) {
          const initializerExpressionText = declExpression.getText();
          switch (initializerExpressionText) {
            case 'signal':
            case 'computed':
            case 'input':
            case 'linkedSignal':
            case 'viewChild':
              throw new Error('TODO: found unexpected non-angular signal init');
          }
        } else if (
          ts.isPropertyAccessExpression(declExpression) &&
          declExpression.name.getText() === 'asReadonly'
        ) {
          throw new Error('TODO: found non-angular asReadonly signal');
        }
      }
    }
  }
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

function isRightSideOfQualifiedNameOrPropertyAccess(node: ts.Node): boolean {
  return (
    (ts.isQualifiedName(node.parent) && node.parent.right === node) ||
    (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  );
}

class TemplateSemanticClassifierVisitor extends TmplAstRecursiveVisitor {
  readonly blocks = [] as Array<TmplAstBlockNode>;
  expressionVisitor: ExpressionsSemanticClassifierVisitor;

  constructor(
    typeChecker: ts.TypeChecker,
    templateTypeChecker: TemplateTypeChecker,
    component: ts.ClassDeclaration,
    private span: ts.TextSpan,
    addSignalSpan: AddSignalSpan,
    sourceFile?: ts.SourceFile,
  ) {
    super();
    this.expressionVisitor = new ExpressionsSemanticClassifierVisitor(
      typeChecker,
      templateTypeChecker,
      component,
      span,
      addSignalSpan,
      sourceFile,
    );
  }

  static collectSignalSpans(
    templateNodes: TmplAstNode[],
    typeChecker: ts.TypeChecker,
    templateTypeChecker: TemplateTypeChecker,
    component: ts.ClassDeclaration,
    span: ts.TextSpan,
    addSignalSpan: AddSignalSpan,
    sourceFile?: ts.SourceFile,
  ): void {
    const visitor = new TemplateSemanticClassifierVisitor(
      typeChecker,
      templateTypeChecker,
      component,
      span,
      addSignalSpan,
      sourceFile,
    );
    tmplAstVisitAll(visitor, templateNodes);
  }

  visit(node: TmplAstNode) {
    if (!textSpanIntersectsWithParseSpan(this.span, node.sourceSpan)) {
      return;
    }
    if (
      node instanceof TmplAstLetDeclaration ||
      node instanceof TmplAstBoundAttribute ||
      node instanceof TmplAstBoundText
    ) {
      this.expressionVisitor.visit(node.value);
    } else if (node instanceof TmplAstBoundEvent) {
      this.expressionVisitor.visit(node.handler);
    } else if (node instanceof TmplAstForLoopBlock || node instanceof TmplAstSwitchBlock) {
      this.expressionVisitor.visit(node.expression);
    } else if (node instanceof TmplAstForLoopBlock) {
      this.expressionVisitor.visit(node.trackBy);
    }
    node.visit(this);
  }
}

/** Visitor that verifies the semantics of the expressions within a template. */
class ExpressionsSemanticClassifierVisitor extends RecursiveAstVisitor {
  constructor(
    private typeChecker: ts.TypeChecker,
    private templateTypeChecker: TemplateTypeChecker,
    private component: ts.ClassDeclaration,
    private span: ts.TextSpan,
    private addSignalSpan: AddSignalSpan,
    private sourceFile?: ts.SourceFile,
  ) {
    super();
  }

  override visitPropertyRead(ast: PropertyRead, context: TmplAstNode) {
    super.visitPropertyRead(ast, context);
    // TODO
    const symbol = this.templateTypeChecker.getSymbolOfNode(ast, this.component);
    type UnionKey<T> = T extends never ? never : keyof T;
    type ExtractWithKey<T, K extends UnionKey<T>> = T extends {[_ in K]?: unknown}
      ? T
      : T & {[_ in K]?: never};
    const tsSymbol = (symbol as ExtractWithKey<typeof symbol, 'tsSymbol'>).tsSymbol;
    const tsType = (symbol as ExtractWithKey<typeof symbol, 'tsType'>).tsType;
    if (tsType && tsSymbol) {
      collectSignal(tsType, tsSymbol, (isReadonly, isInput) => {
        const {start} = ast.span;
        this.addSignalSpan(start, ast.span.end - start, isReadonly, isInput);
      });
    }
  }
}
