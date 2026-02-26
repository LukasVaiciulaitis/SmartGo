package com.example.smartgoprototype.ui.login

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
 * ViewModel for the login screen.
 *
 * Uses `mutableStateOf` (instead of Flow) because the state here is small, UI-local, and updated
 * frequently by text input. Compose can observe this directly and recompose efficiently.
 */
@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    // UI state is mutable internally; the setter is private so only this ViewModel can update it.
    var uiState by mutableStateOf(LoginUiState())
        private set

    fun onEmailChanged(newEmail: String) {
        // Clear field + general errors as the user edits, then re-validate.
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

    fun onTogglePasswordVisibility() {
        uiState = uiState.copy(
            isPasswordVisible = !uiState.isPasswordVisible
        )
    }

    fun onLoginClicked() {
        // Guard against duplicate taps and invalid input.
        if (!uiState.isLoginEnabled || uiState.isLoading) return

        // optimistic UI update
        uiState = uiState.copy(
            isLoading = true,
            generalError = null,
            isLoginSuccessful = false
        )

        // capture current values to avoid races if user types during call
        val identifier = uiState.email
        val password = uiState.password

        viewModelScope.launch {
            val result = authRepository.login(identifier, password)

            uiState = result.fold(
                onSuccess = {
                    uiState.copy(
                        isLoading = false,
                        generalError = null,
                        isLoginSuccessful = true
                    )
                },
                onFailure = { throwable ->
                    uiState.copy(
                        isLoading = false,
                        generalError = throwable.message
                            ?: "Login failed. Please try again.",
                        isLoginSuccessful = false
                    )
                }
            )
        }
    }

    /**
     * Local validation to support immediate UI feedback (enable/disable button, inline errors).
     *
     * This is intentionally lightweight; deeper validation belongs on the backend.
     */
    private fun LoginUiState.validate(): LoginUiState {
        val isIdentifierValid = email.isNotBlank()
        val isPasswordValid = password.length >= 6

        return copy(
            emailError = if (!isIdentifierValid) "Required" else null,
            passwordError = if (password.isNotBlank() && !isPasswordValid) "At least 6 characters" else null,
            isLoginEnabled = isIdentifierValid && isPasswordValid && !isLoading
        )
    }
}
