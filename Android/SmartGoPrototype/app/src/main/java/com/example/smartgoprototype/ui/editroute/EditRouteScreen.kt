package com.example.smartgoprototype.ui.editroute

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.ui.addroute.ArriveByTimeInput
import com.example.smartgoprototype.ui.addroute.DaysOfWeekChips
import com.example.smartgoprototype.ui.addroute.TravelModePicker
import java.time.DayOfWeek

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditRouteScreen(
    uiState: EditRouteUiState,
    onBack: () -> Unit,
    onTitleChange: (String) -> Unit,
    onTravelModeSelected: (TravelMode) -> Unit,
    onArriveByChange: (hour: Int, minute: Int) -> Unit,
    onToggleDay: (DayOfWeek) -> Unit,
    onSave: () -> Unit
) {
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(uiState.errorMessage) {
        uiState.errorMessage?.let { snackbarHostState.showSnackbar(it) }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Edit route") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            if (!uiState.isLoading) {
                Surface(tonalElevation = 2.dp) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalArrangement = Arrangement.End
                    ) {
                        Button(onClick = onSave, enabled = uiState.canSave) {
                            if (uiState.isSaving) {
                                CircularProgressIndicator(strokeWidth = 2.dp)
                            } else {
                                Text("Save")
                            }
                        }
                    }
                }
            }
        }
    ) { inner ->
        if (uiState.isLoading) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(inner),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator()
            }
        } else {
            // key ensures rememberTimePickerState is initialised with the loaded values.
            key(uiState.routeId) {
                val arriveByState = rememberTimePickerState(
                    initialHour = uiState.arriveBy.hour,
                    initialMinute = uiState.arriveBy.minute,
                    is24Hour = true
                )

                LaunchedEffect(arriveByState.hour, arriveByState.minute) {
                    if (arriveByState.hour != uiState.arriveBy.hour || arriveByState.minute != uiState.arriveBy.minute) {
                        onArriveByChange(arriveByState.hour, arriveByState.minute)
                    }
                }

                Column(
                    modifier = Modifier
                        .padding(inner)
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedTextField(
                        value = uiState.title,
                        onValueChange = onTitleChange,
                        label = { Text("Route title") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    OutlinedTextField(
                        value = uiState.originLabel,
                        onValueChange = {},
                        label = { Text("Origin") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        readOnly = true,
                        enabled = false
                    )

                    OutlinedTextField(
                        value = uiState.destinationLabel,
                        onValueChange = {},
                        label = { Text("Destination") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        readOnly = true,
                        enabled = false
                    )

                    Text(
                        "To change origin or destination, delete and recreate the route.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    ArriveByTimeInput(state = arriveByState)

                    TravelModePicker(
                        selected = uiState.travelMode,
                        onSelected = onTravelModeSelected
                    )

                    DaysOfWeekChips(selected = uiState.activeDays, onToggle = onToggleDay)
                }
            }
        }
    }
}
