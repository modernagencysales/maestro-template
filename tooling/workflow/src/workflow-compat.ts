import {
  createSampleWorkflowRunReceipt,
  templateRegistry,
  validateTemplateRegistry,
  type TemplateRegistry,
  type WorkflowRunReceipt,
} from "@maestro-template/template-core";

export const describeDefaultWorkflow = (
  capabilityCount: number,
  headlessOperationCount: number,
) => {
  const validationErrors = validateTemplateRegistry(templateRegistry);

  return {
    valid: validationErrors.length === 0,
    validationErrors,
    nodeCount: templateRegistry.workflow.nodes.length,
    edgeCount: templateRegistry.workflow.edges.length,
    capabilityCount,
    agentCount: templateRegistry.agents.length,
    headlessOperationCount,
  };
};

export const describeWorkflowRegistry = (
  registry: TemplateRegistry,
  capabilityCount: number,
  headlessOperationCount: number,
) => {
  const validationErrors = validateTemplateRegistry(registry);

  return {
    valid: validationErrors.length === 0,
    validationErrors,
    nodeCount: registry.workflow.nodes.length,
    edgeCount: registry.workflow.edges.length,
    capabilityCount,
    agentCount: registry.agents.length,
    headlessOperationCount,
  };
};

export const runDefaultWorkflow = (): WorkflowRunReceipt =>
  createSampleWorkflowRunReceipt(templateRegistry);

export const runWorkflowRegistry = (
  registry: TemplateRegistry,
): WorkflowRunReceipt => createSampleWorkflowRunReceipt(registry);
