package com.example.smartgoprototype.domain.repository

/**
 * Domain-facing authentication API.
 *
 * Returning `Result<Unit>` keeps the surface small for UI:
 * - Success is `Unit`
 * - Failure carries the thrown exception/error for display or logging
 */
interface AuthRepository {
    suspend fun login(identifier: String, password: String): Result<Unit>
    suspend fun register(username: String, email: String, password: String): Result<Unit>
    suspend fun confirmSignUp(username: String, code: String): Result<Unit>
}
