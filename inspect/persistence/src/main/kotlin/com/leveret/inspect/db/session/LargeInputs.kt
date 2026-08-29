package com.leveret.inspect.db.session

/**
 * Statement parameter limits and planner behavior degrade with very large `in` lists, so an oversized
 * input collection is split and the results concatenated.
 */
object LargeInputs {
    const val PARTITION_SIZE = 1000

    fun <I, O> read(input: Collection<I>, block: (List<I>) -> Collection<O>): List<O> =
        input.chunked(PARTITION_SIZE).flatMap(block)

    fun <I> update(input: Collection<I>, block: (List<I>) -> Int): Int =
        input.chunked(PARTITION_SIZE).sumOf(block)
}
