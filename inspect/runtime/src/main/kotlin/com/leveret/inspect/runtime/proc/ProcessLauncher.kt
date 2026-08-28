package com.leveret.inspect.runtime.proc

import kotlin.concurrent.thread

/**
 * Creates child operating-system processes and drains their output.
 *
 * Standard error is merged into standard output so early startup and crash output stay observable in
 * the child's own log. Drain failures are suppressed and never change process state: readiness and
 * operating-system liveness remain authoritative.
 */
class ProcessLauncher(
    private val consoleOutput: Boolean,
    private val logLine: (ProcessId, String) -> Unit,
) {
    fun launch(command: ChildCommand): Process {
        val builder = ProcessBuilder(command.arguments).redirectErrorStream(true)
        val environment = builder.environment()
        environment.putAll(command.environmentAdditions)
        command.suppressedEnvironment.forEach(environment::remove)
        val process = builder.start()
        drain(command.id, process)
        return process
    }

    private fun drain(id: ProcessId, process: Process) {
        thread(isDaemon = true, name = "${id.key}-output") {
            try {
                process.inputStream.bufferedReader().forEachLine { line ->
                    logLine(id, line)
                    if (consoleOutput) println(line)
                }
            } catch (_: Exception) {
                // Intentionally suppressed: a broken output reader is not a process failure.
            }
        }
    }
}
