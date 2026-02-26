package com.example.smartgoprototype.ui.register

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the registration screen.
 *
 * Responsibilities:
 * - Holds form state and performs basic client-side validation for user feedback.
 * - Invokes [AuthRepository.register] and exposes success/failure in [RegisterUiState].
 *
 * uses Compose state (`mutableStateOf`) for simple, high-frequency updates.
 */
@HiltViewModel
class RegisterViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    var uiState by mutableStateOf(RegisterUiState())
        private set

    fun onEmailChanged(newEmail: String) {
        uiState = uiState.copy(
            email = newEmail,
            emailError = null,
            generalError = null
        ).validate()
    }

    fun onPasswordChanged(newPassword: String) {
        uiState = uiState.copy(
            password = newPassword,
            passwordError = null,
            generalError = null
        ).validate()
    }

    fun onConfirmPasswordChanged(newConfirmPassword: String) {
        uiState = uiState.copy(
            confirmPassword = newConfirmPassword,
            confirmPasswordError = null,
            generalError = null
        ).validate()
    }

    fun onTogglePasswordVisibility() {
        uiState = uiState.copy(
            isPasswordVisible = !uiState.isPasswordVisible
        )
    }

    fun onToggleConfirmPasswordVisibility() {
        uiState = uiState.copy(
            isConfirmPasswordVisible = !uiState.isConfirmPasswordVisible
        )
    }

    fun onRegisterClicked() {
        // Prevent duplicate submissions and disallow registering with invalid inputs.
        if (!uiState.isRegisterEnabled || uiState.isLoading) return

        uiState = uiState.copy(
            isLoading = true,
            generalError = null,
            isRegisterSuccessful = false
        )

        // Capture current values once so edits during the network call don't change what is submitted.
        val email = uiState.email.trim().lowercase()
        val password = uiState.password

        viewModelScope.launch {
            val result = authRepository.register(email, password)

            uiState = result.fold(
                onSuccess = {
                    uiState.copy(
                        isLoading = false,
                        generalError = null,
                        isRegisterSuccessful = true
                    )
                },
                onFailure = { throwable ->
                    uiState.copy(
                        isLoading = false,
                        generalError = throwable.message
                            ?: "Registration failed. Please try again.",
                        isRegisterSuccessful = false
                    )
                }
            )
        }
    }

    /**
     * Client-side validation for UX (inline errors + enabling/disabling the Register button).
     *
     * TODO: extend validation and comply with backend
     */
    private fun RegisterUiState.validate(): RegisterUiState {
        val isEmailValid =
            email.isNotBlank() && android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()
        val isPasswordValid = password.length >= 8
        val isConfirmValid = confirmPassword == password && confirmPassword.isNotBlank()

        return copy(
            emailError = if (email.isNotBlank() && !isEmailValid) "Invalid email" else null,
            passwordError = if (password.isNotBlank() && !isPasswordValid) "At least 8 characters" else null,
            confirmPasswordError = when {
                confirmPassword.isNotBlank() && confirmPassword != password -> "Passwords do not match"
                else -> null
            },
            isRegisterEnabled = isEmailValid && isPasswordValid && isConfirmValid && !isLoading
        )
    }
}