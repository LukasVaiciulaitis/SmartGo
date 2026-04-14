package com.example.smartgoprototype.data.auth

import javax.inject.Inject
import javax.inject.Singleton

/**
 * Holds credentials in memory across the registration → confirmation flow so that
 * [ConfirmSignUpViewModel] can auto-sign-in after a successful email verification
 * without exposing the password in a navigation argument.
 *
 * Cleared immediately after use.
 */
@Singleton
class PendingRegistrationCredentials @Inject constructor() {
    @Volatile var email: String = ""
    @Volatile var password: String = ""

    fun set(email: String, password: String) {
        this.email = email
        this.password = password
    }

    fun clear() {
        email = ""
        password = ""
    }
}
