"""Independent exact proof checker. It does not import the proof searcher."""
from pathlib import Path
from fractions import Fraction
import argparse
import importlib.util
import json
import time

spec = importlib.util.spec_from_file_location('proof_kernel', Path(__file__).with_name('optimizer-proof-kernel.py'))
K = importlib.util.module_from_spec(spec);spec.loader.exec_module(K)


class InvalidProof(ValueError):
    pass


def check(condition, message):
    if not condition:
        raise InvalidProof(message)


def verify(source, proof, seconds=30, max_nodes=2000000):
    start = time.monotonic();nodes = 0;operations = 0
    def tick():
        nonlocal operations
        operations += 1
        if (operations == 1 or operations % 128 == 0) and time.monotonic() - start > seconds:
            raise InvalidProof('Proof verification budget exhausted')
        check(nodes <= max_nodes, 'Proof verification node limit')
    check(proof.get('version') == K.VERSION and proof.get('inputHash') == K.input_hash(source), 'Wrong version/input binding')
    check(proof.get('complete') is True, 'Incomplete proof cannot certify optimality')
    problem = K.Problem(source, tick)
    order = proof['order']
    check(all(type(i) is int for i in order) and sorted(order) == list(range(len(problem.domains))), 'Order is not a complete permutation')
    phases = proof['phases'];threshold = None;minimum = maximum = None;final = None
    expected = ['score'] if problem.mode == 'none' else ['minCRT', 'maxCRT', 'score']
    check(0 < len(phases) <= len(expected), 'Invalid phase count')
    for phase_index, phase in enumerate(phases):
        mode = expected[phase_index]
        check(phase['mode'] == mode, 'Missing/reordered proof phase')
        witness = phase['witness']
        claim = problem.evaluate_witness(witness, mode, threshold) if witness is not None else None
        check(witness is None or claim is not None, 'Invalid claim witness')
        check(phase['value'] == (str(claim) if claim is not None else None), 'Claim value is not the exact witness value')
        roots = phase['roots'];check(len(roots) == len(problem.foods), 'Missing food coverage')
        selection = [None] * len(problem.domains)

        def visit(node, depth, raw, selected, food_index):
            nonlocal nodes
            nodes += 1;tick();remaining = order[depth:];food = problem.foods[food_index]
            if node == 'I':
                check(problem.impossible(raw, selected, remaining, food, threshold), 'Unsound infeasibility leaf')
            elif node == 'B':
                check(claim is not None, 'Bound leaf has no attainable claim')
                bound = problem.bound(raw, selected, remaining, food, mode, threshold)
                check(bound >= claim if mode == 'minCRT' else bound <= claim, 'Unsound objective bound')
            elif node == 'L':
                check(not remaining, 'Leaf omits remaining raw choices')
                value = problem.evaluate_witness({'food': food_index, 'selection': list(selection)}, mode, threshold)
                if value is not None:
                    check(claim is not None and (value >= claim if mode == 'minCRT' else value <= claim), 'Leaf defeats the claim')
            else:
                check(type(node) is list and len(node) == 2 and node[0] == 'S' and remaining, 'Malformed branch')
                children = node[1];index = remaining[0]
                check(type(children) is list and len(children) == len(problem.domains[index]), 'Branch omits raw options')
                for option_index, (child, option) in enumerate(zip(children, problem.domains[index])):
                    selection[index] = option_index
                    visit(child, depth + 1, K.add(raw, option['stats']), selected + [option], food_index)
                selection[index] = None

        for food_index, root in enumerate(roots):
            visit(root, 0, {}, [], food_index)
        if claim is None:
            check(phase_index == len(phases) - 1, 'Unexpected phases after infeasibility')
            check(mode in ('score', 'minCRT'), 'Missing maximum after feasible minimum')
            return {'status': 'certified-infeasible', 'proofVerified': True, 'inputHash': K.input_hash(source), 'version': K.VERSION, 'nodes': nodes, 'verificationMs': (time.monotonic() - start) * 1000}
        if mode == 'minCRT':
            minimum = claim
        elif mode == 'maxCRT':
            maximum = claim
            check(minimum <= maximum, 'Invalid CRT range')
            threshold = minimum + (maximum - minimum) * Fraction(3 if problem.mode == 'high' else 1, 4)
        else:
            final = problem.public_result(witness)
    check(len(phases) == len(expected) and final is not None, 'Missing final score proof')
    if threshold is not None:
        final['criticalRange'] = {'minimum': float(minimum), 'maximum': float(maximum), 'midpoint': float((minimum + maximum) / 2), 'threshold': float(threshold)}
    return {'status': 'certified-optimal', 'proofVerified': True, 'inputHash': K.input_hash(source), 'version': K.VERSION, 'exactScore': final['exactScore'], 'result': final, 'nodes': nodes, 'verificationMs': (time.monotonic() - start) * 1000}


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--input', type=Path, required=True);parser.add_argument('--proof', type=Path, required=True);parser.add_argument('--output', type=Path, required=True);parser.add_argument('--seconds', type=float, default=30);parser.add_argument('--nodes', type=int, default=2000000);args = parser.parse_args()
    try:
        check(args.input.stat().st_size <= 64 * 1024 * 1024 and args.proof.stat().st_size <= 64 * 1024 * 1024, 'Certificate/input exceeds64MiB limit')
        input_bytes = args.input.read_bytes();proof_bytes = args.proof.read_bytes()
        result = verify(json.loads(input_bytes), json.loads(proof_bytes), args.seconds, args.nodes)
        result['inputFileSha256'] = K.hashlib.sha256(input_bytes).hexdigest()
        result['certificateFileSha256'] = K.hashlib.sha256(proof_bytes).hexdigest()
    except Exception as error:
        result = {'status': 'unproven', 'proofVerified': False, 'reason': str(error)}
    args.output.write_text(json.dumps(result, ensure_ascii=False));print(json.dumps(result, ensure_ascii=False))
