/* eslint-disable  @typescript-eslint/no-explicit-any */
import { decompressSync as gunzip } from 'fflate';
import { acirToUint8Array } from './serialize.js';
import { Backend, CompiledCircuit, ProofData } from '@noir-lang/types';
import { BackendOptions } from './types.js';
import { deflattenPublicInputs, flattenPublicInputsAsArray } from './public_inputs.js';

export { flattenPublicInputs } from './public_inputs.js';

// This is the number of bytes in a UltraPlonk proof
// minus the public inputs.
const numBytesInProofWithoutPublicInputs: number = 2144;

export class BarretenbergBackend implements Backend {
  // These type assertions are used so that we don't
  // have to initialize `api` and `acirComposer` in the constructor.
  // These are initialized asynchronously in the `init` function,
  // constructors cannot be asynchronous which is why we do this.
  private api: any;
  private acirComposer: any;
  private acirUncompressedBytecode: Uint8Array;

  constructor(
    private acirCircuit: CompiledCircuit,
    private options: BackendOptions = { threads: 1 },
  ) {
    const acirBytecodeBase64 = acirCircuit.bytecode;
    this.acirUncompressedBytecode = acirToUint8Array(acirBytecodeBase64);
  }

  /** @ignore */
  async instantiate(): Promise<void> {
    if (!this.api) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore
      const { Barretenberg, RawBuffer, Crs } = await import('@aztec/bb.js');
      const api = await Barretenberg.new(this.options.threads);

      const [_exact, _total, subgroupSize] = await api.acirGetCircuitSizes(this.acirUncompressedBytecode);
      const crs = await Crs.new(subgroupSize + 1);
      await api.commonInitSlabAllocator(subgroupSize);
      await api.srsInitSrs(new RawBuffer(crs.getG1Data()), crs.numPoints, new RawBuffer(crs.getG2Data()));

      this.acirComposer = await api.acirNewAcirComposer(subgroupSize);
      await api.acirInitProvingKey(this.acirComposer, this.acirUncompressedBytecode);
      this.api = api;
    }
  }

  // Generate an outer proof. This is the proof for the circuit which will verify
  // inner proofs and or can be seen as the proof created for regular circuits.
  //
  // The settings for this proof are the same as the settings for a "normal" proof
  // ie one that is not in the recursive setting.
  async generateFinalProof(decompressedWitness: Uint8Array): Promise<ProofData> {
    const makeEasyToVerifyInCircuit = false;
    return this.generateProof(decompressedWitness, makeEasyToVerifyInCircuit);
  }

  // Generates an inner proof. This is the proof that will be verified
  // in another circuit.
  //
  // This is sometimes referred to as a recursive proof.
  // We avoid this terminology as the only property of this proof
  // that matters, is the fact that it is easy to verify in another
  // circuit. We _could_ choose to verify this proof in the CLI.
  //
  // We set `makeEasyToVerifyInCircuit` to true, which will tell the backend to
  // generate the proof using components that will make the proof
  // easier to verify in a circuit.

  /**
   *
   * @example
   * ```typescript
   * const intermediateProof = await backend.generateIntermediateProof(witness);
   * ```
   */
  async generateIntermediateProof(witness: Uint8Array): Promise<ProofData> {
    const makeEasyToVerifyInCircuit = true;
    return this.generateProof(witness, makeEasyToVerifyInCircuit);
  }

  /** @ignore */
  async generateProof(compressedWitness: Uint8Array, makeEasyToVerifyInCircuit: boolean): Promise<ProofData> {
    await this.instantiate();
    const proofWithPublicInputs = await this.api.acirCreateProof(
      this.acirComposer,
      this.acirUncompressedBytecode,
      gunzip(compressedWitness),
      makeEasyToVerifyInCircuit,
    );

    const splitIndex = proofWithPublicInputs.length - numBytesInProofWithoutPublicInputs;

    const publicInputsConcatenated = proofWithPublicInputs.slice(0, splitIndex);
    const proof = proofWithPublicInputs.slice(splitIndex);
    const publicInputs = deflattenPublicInputs(publicInputsConcatenated, this.acirCircuit.abi);

    return { proof, publicInputs };
  }

  // Generates artifacts that will be passed to a circuit that will verify this proof.
  //
  // Instead of passing the proof and verification key as a byte array, we pass them
  // as fields which makes it cheaper to verify in a circuit.
  //
  // The proof that is passed here will have been created using the `generateInnerProof`
  // method.
  //
  // The number of public inputs denotes how many public inputs are in the inner proof.

  /**
   *
   * @example
   * ```typescript
   * const artifacts = await backend.generateIntermediateProofArtifacts(proof, numOfPublicInputs);
   * ```
   */
  async generateIntermediateProofArtifacts(
    proofData: ProofData,
    numOfPublicInputs = 0,
  ): Promise<{
    proofAsFields: string[];
    vkAsFields: string[];
    vkHash: string;
  }> {
    await this.instantiate();
    const proof = reconstructProofWithPublicInputs(proofData);
    const proofAsFields = await this.api.acirSerializeProofIntoFields(this.acirComposer, proof, numOfPublicInputs);

    // TODO: perhaps we should put this in the init function. Need to benchmark
    // TODO how long it takes.
    await this.api.acirInitVerificationKey(this.acirComposer);

    // Note: If you don't init verification key, `acirSerializeVerificationKeyIntoFields`` will just hang on serialization
    const vk = await this.api.acirSerializeVerificationKeyIntoFields(this.acirComposer);

    return {
      proofAsFields: proofAsFields.map((p) => p.toString()),
      vkAsFields: vk[0].map((vk) => vk.toString()),
      vkHash: vk[1].toString(),
    };
  }

  async verifyFinalProof(proofData: ProofData): Promise<boolean> {
    const proof = reconstructProofWithPublicInputs(proofData);
    const makeEasyToVerifyInCircuit = false;
    const verified = await this.verifyProof(proof, makeEasyToVerifyInCircuit);
    return verified;
  }

  /**
   *
   * @example
   * ```typescript
   * const isValidIntermediate = await backend.verifyIntermediateProof(proof);
   * ```
   */
  async verifyIntermediateProof(proofData: ProofData): Promise<boolean> {
    const proof = reconstructProofWithPublicInputs(proofData);
    const makeEasyToVerifyInCircuit = true;
    return this.verifyProof(proof, makeEasyToVerifyInCircuit);
  }

  /** @ignore */
  async verifyProof(proof: Uint8Array, makeEasyToVerifyInCircuit: boolean): Promise<boolean> {
    await this.instantiate();
    await this.api.acirInitVerificationKey(this.acirComposer);
    return await this.api.acirVerifyProof(this.acirComposer, proof, makeEasyToVerifyInCircuit);
  }

  async destroy(): Promise<void> {
    if (!this.api) {
      return;
    }
    await this.api.destroy();
  }
}

function reconstructProofWithPublicInputs(proofData: ProofData): Uint8Array {
  // Flatten publicInputs
  const publicInputsConcatenated = flattenPublicInputsAsArray(proofData.publicInputs);

  // Concatenate publicInputs and proof
  const proofWithPublicInputs = Uint8Array.from([...publicInputsConcatenated, ...proofData.proof]);

  return proofWithPublicInputs;
}

// typedoc exports
export { Backend, BackendOptions, CompiledCircuit, ProofData };
