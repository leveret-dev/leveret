package com.leveret.inspect.runtime.ipc

import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE

/**
 * Memory-mapped file coordinating the node's processes.
 *
 * The file reserves one fixed-size slot per process index, including indexes no identity owns yet, so
 * slot addresses stay stable across releases. This is local file coordination and carries no
 * authentication: the trust boundary is the ownership of [directory].
 */
class CommandFile(directory: Path) : AutoCloseable {
    private val channel: FileChannel =
        FileChannel.open(directory.resolve(FILE_NAME), CREATE, READ, WRITE)

    private val buffer: MappedByteBuffer =
        channel.map(FileChannel.MapMode.READ_WRITE, 0, TOTAL_SIZE.toLong())

    /** Zeroes every reserved slot, so state from an earlier node instance cannot be observed. */
    fun clearAll() {
        for (index in 0 until ProcessId.MAX_PROCESSES) {
            clearSlot(index * SLOT_SIZE)
        }
    }

    /** Returns a view of the slot at [index], leaving its current content untouched. */
    fun view(index: Int): ProcessCommands = MappedProcessCommands(offsetOf(index))

    /** Returns a view of the slot at [index] for the process that owns it, clearing it first. */
    fun mainView(index: Int): ProcessCommands {
        val offset = offsetOf(index)
        clearSlot(offset)
        return MappedProcessCommands(offset)
    }

    override fun close() {
        buffer.force()
        channel.close()
    }

    private fun offsetOf(index: Int): Int {
        require(index in 0 until ProcessId.MAX_PROCESSES) {
            "Process index out of reserved range: $index"
        }
        return index * SLOT_SIZE
    }

    private fun clearSlot(offset: Int) {
        buffer.put(offset, EMPTY_SLOT, 0, SLOT_SIZE)
    }

    private inner class MappedProcessCommands(private val offset: Int) : ProcessCommands {
        override var up: Boolean
            get() = flag(UP_OFFSET)
            set(value) = flag(UP_OFFSET, value)

        override var operational: Boolean
            get() = flag(OPERATIONAL_OFFSET)
            set(value) = flag(OPERATIONAL_OFFSET, value)

        override var askedForStop: Boolean
            get() = flag(STOP_OFFSET)
            set(value) = flag(STOP_OFFSET, value)

        override var askedForHardStop: Boolean
            get() = flag(HARD_STOP_OFFSET)
            set(value) = flag(HARD_STOP_OFFSET, value)

        override var askedForRestart: Boolean
            get() = flag(RESTART_OFFSET)
            set(value) = flag(RESTART_OFFSET, value)

        override fun acknowledgeRestart() = flag(RESTART_OFFSET, false)

        override var systemInfoUrl: String?
            get() {
                val bytes = ByteArray(MAX_URL_BYTES)
                buffer.get(offset + URL_OFFSET, bytes, 0, MAX_URL_BYTES)
                val length = bytes.indexOf(0).let { if (it < 0) MAX_URL_BYTES else it }
                return if (length == 0) null else String(bytes, 0, length, StandardCharsets.US_ASCII)
            }
            set(value) {
                val encoded = value?.toByteArray(StandardCharsets.US_ASCII) ?: ByteArray(0)
                require(encoded.size <= MAX_URL_BYTES) {
                    "System information URL exceeds $MAX_URL_BYTES bytes: ${encoded.size}"
                }
                val field = ByteArray(MAX_URL_BYTES)
                encoded.copyInto(field)
                buffer.put(offset + URL_OFFSET, field, 0, MAX_URL_BYTES)
            }

        override fun ping(): Long {
            buffer.putLong(offset + PING_OFFSET, System.currentTimeMillis())
            return buffer.getLong(offset + PING_OFFSET)
        }

        override fun clear() = clearSlot(offset)

        private fun flag(flagOffset: Int): Boolean = buffer.get(offset + flagOffset) != 0.toByte()

        private fun flag(flagOffset: Int, value: Boolean) {
            buffer.put(offset + flagOffset, if (value) 1 else 0)
        }
    }

    companion object {
        const val FILE_NAME = "sharedmemory"
        const val SLOT_SIZE = 513
        const val MAX_URL_BYTES = 500

        private const val UP_OFFSET = 0
        private const val HARD_STOP_OFFSET = 1
        private const val STOP_OFFSET = 2
        private const val RESTART_OFFSET = 3
        private const val OPERATIONAL_OFFSET = 4
        private const val PING_OFFSET = 5
        private const val URL_OFFSET = 13

        private const val TOTAL_SIZE = SLOT_SIZE * ProcessId.MAX_PROCESSES
        private val EMPTY_SLOT = ByteArray(SLOT_SIZE)
    }
}
