use super::{
    basic_block::{BasicBlock, BasicBlockId},
    function::Signature,
    instruction::{Instruction, InstructionId},
    map::{DenseMap, Id, SecondaryMap},
    types::Type,
    value::{Value, ValueId},
};

use iter_extended::vecmap;

#[derive(Debug, Default)]
/// A convenience wrapper to store `Value`s.
pub(crate) struct ValueList(Vec<Id<Value>>);

impl ValueList {
    /// Inserts an element to the back of the list and
    /// returns the `position`
    pub(crate) fn push(&mut self, value: ValueId) -> usize {
        self.0.push(value);
        self.len() - 1
    }
    /// Returns the number of values in the list.
    fn len(&self) -> usize {
        self.0.len()
    }

    /// Removes all items from the list.
    fn clear(&mut self) {
        self.0.clear();
    }
    /// Returns the ValueId's as a slice.
    pub(crate) fn as_slice(&self) -> &[ValueId] {
        &self.0
    }
}

#[derive(Debug, Default)]
pub(crate) struct DataFlowGraph {
    /// All of the instructions in a function
    instructions: DenseMap<Instruction>,

    /// Stores the results for a particular instruction.
    ///
    /// An instruction may return multiple values
    /// and for this, we will also use the cranelift strategy
    /// to fetch them via indices.
    ///
    /// Currently, we need to define them in a better way
    /// Call instructions require the func signature, but
    /// other instructions may need some more reading on my part
    results: SecondaryMap<Instruction, ValueList>,

    /// Storage for all of the values defined in this
    /// function.
    values: DenseMap<Value>,

    /// Function signatures of external methods
    signatures: DenseMap<Signature>,

    /// All blocks in a function
    blocks: DenseMap<BasicBlock>,
}

impl DataFlowGraph {
    /// Creates a new basic block with no parameters.
    /// After being created, the block is unreachable in the current function
    /// until another block is made to jump to it.
    pub(crate) fn new_block(&mut self) -> BasicBlockId {
        self.blocks.insert(BasicBlock::new(Vec::new()))
    }

    /// Creates a new basic block with the given parameters.
    /// After being created, the block is unreachable in the current function
    /// until another block is made to jump to it.
    pub(crate) fn new_block_with_parameters(
        &mut self,
        parameter_types: impl Iterator<Item = Type>,
    ) -> BasicBlockId {
        self.blocks.insert_with_id(|entry_block| {
            let parameters = vecmap(parameter_types.enumerate(), |(position, typ)| {
                self.values.insert(Value::Param { block: entry_block, position, typ })
            });

            BasicBlock::new(parameters)
        })
    }

    pub(crate) fn block_parameters(&self, block: BasicBlockId) -> &[ValueId] {
        self.blocks[block].parameters()
    }

    /// Inserts a new instruction into the DFG.
    pub(crate) fn make_instruction(&mut self, instruction_data: Instruction) -> InstructionId {
        let id = self.instructions.insert(instruction_data);

        // Create a new vector to store the potential results for the instruction.
        self.results.insert(id, Default::default());
        id
    }

    pub(crate) fn make_value(&mut self, value: Value) -> ValueId {
        self.values.insert(value)
    }

    /// Attaches results to the instruction.
    ///
    /// Returns the number of results that this instruction
    /// produces.
    pub(crate) fn make_instruction_results(
        &mut self,
        instruction_id: InstructionId,
        ctrl_typevar: Type,
    ) -> usize {
        // Clear all of the results instructions associated with this
        // instruction.
        self.results.get_mut(&instruction_id).expect("all instructions should have a `result` allocation when instruction was added to the DFG").clear();

        // Get all of the types that this instruction produces
        // and append them as results.
        let typs = self.instruction_result_types(instruction_id, ctrl_typevar);
        let num_typs = typs.len();

        for typ in typs {
            self.append_result(instruction_id, typ);
        }

        num_typs
    }

    /// Return the result types of this instruction.
    ///
    /// For example, an addition instruction will return
    /// one type which is the type of the operands involved.
    /// This is the `ctrl_typevar` in this case.
    fn instruction_result_types(
        &self,
        instruction_id: InstructionId,
        ctrl_typevar: Type,
    ) -> Vec<Type> {
        // Check if it is a call instruction. If so, we don't support that yet
        let ins_data = &self.instructions[instruction_id];
        match ins_data {
            Instruction::Call { .. } => todo!("function calls are not supported yet"),
            ins => ins.return_types(ctrl_typevar),
        }
    }

    /// Appends a result type to the instruction.
    pub(crate) fn append_result(&mut self, instruction_id: InstructionId, typ: Type) -> ValueId {
        let results = self.results.get_mut(&instruction_id).unwrap();
        let expected_res_position = results.len();

        let value_id = self.values.insert(Value::Instruction {
            typ,
            position: expected_res_position,
            instruction: instruction_id,
        });

        // Add value to the list of results for this instruction
        let actual_res_position = results.push(value_id);
        assert_eq!(actual_res_position, expected_res_position);
        value_id
    }

    /// Returns the number of instructions
    /// inserted into functions.
    pub(crate) fn num_instructions(&self) -> usize {
        self.instructions.len()
    }

    /// Returns all of result values which are attached to this instruction.
    pub(crate) fn instruction_results(&self, instruction_id: InstructionId) -> &[ValueId] {
        self.results.get(&instruction_id).expect("expected a list of Values").as_slice()
    }

    pub(crate) fn add_block_parameter(&mut self, block_id: BasicBlockId, typ: Type) -> Id<Value> {
        let block = &mut self.blocks[block_id];
        let position = block.parameters().len();
        let parameter = self.values.insert(Value::Param { block: block_id, position, typ });
        block.add_parameter(parameter);
        parameter
    }
}

#[cfg(test)]
mod tests {
    use super::DataFlowGraph;
    use crate::ssa_refactor::ir::{
        instruction::Instruction,
        types::{NumericType, Type},
    };
    use acvm::FieldElement;

    #[test]
    fn make_instruction() {
        let mut dfg = DataFlowGraph::default();
        let ins = Instruction::Immediate { value: FieldElement::from(0u128) };
        let ins_id = dfg.make_instruction(ins);

        let num_results =
            dfg.make_instruction_results(ins_id, Type::Numeric(NumericType::NativeField));

        let results = dfg.instruction_results(ins_id);

        assert_eq!(results.len(), num_results);
    }
}